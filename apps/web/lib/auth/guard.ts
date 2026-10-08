import { DurableObject } from "cloudflare:workers";
import { AuthGuardLimit, AuthGuardStore, type RateRule } from "./guard-store";
import { waitForSignal } from "./request-lifecycle";

export class AuthGuard extends DurableObject<CloudflareEnv> {
  private store: AuthGuardStore;
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.store = new AuthGuardStore(ctx.storage.sql);
  }

  consume(key: string, rule: RateRule) {
    return this.store.consume(key, rule);
  }

  async fetch(request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const { url } = (await request.json()) as { url: string };
    if (typeof url !== "string" || url.length > 2048) return new Response(null, { status: 400 });
    const cached = this.store.cached(url);
    if (cached && cached.expires_at > Date.now()) return cachedResponse(cached);
    let release: () => void;
    try {
      release = this.store.acquireFetch(url);
    } catch (error) {
      return new Response(null, { status: error instanceof AuthGuardLimit ? 429 : 400 });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers({ Accept: "application/json" });
      const previous = cached ? new Headers(JSON.parse(cached.headers)) : null;
      if (previous?.get("etag")) headers.set("If-None-Match", previous.get("etag")!);
      if (previous?.get("last-modified"))
        headers.set("If-Modified-Since", previous.get("last-modified")!);
      // global_fetch_strictly_public is required on this Worker. Never use a
      // private service binding or follow a metadata redirect.
      const response = await waitForSignal(
        fetch(url, { headers, redirect: "manual", signal }),
        signal,
      );
      if (
        response.status === 304 &&
        cached &&
        (headers.has("If-None-Match") || headers.has("If-Modified-Since"))
      ) {
        const merged = previous!;
        for (const [name, value] of publicHeaders(response.headers)) merged.set(name, value);
        if (!response.headers.has("age")) merged.delete("age");
        this.store.store(url, cached.body, merged);
        return new Response(cached.body, { headers: merged });
      }
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, { status: 502 });
      }
      if (
        !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, { status: 502 });
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { value, done } = await waitForSignal(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) {
          void reader.cancel().catch(() => {});
          return new Response(null, { status: 502 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body = new TextDecoder().decode(bytes);
      this.store.store(url, body, response.headers);
      return new Response(body, { headers: publicHeaders(response.headers) });
    } catch {
      void reader?.cancel().catch(() => {});
      return new Response(null, { status: 502 });
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
      release();
    }
  }
}

function publicHeaders(input: Headers) {
  return new Headers(
    [...input.entries()].filter(([name]) =>
      [
        "content-type",
        "cache-control",
        "etag",
        "last-modified",
        "expires",
        "date",
        "age",
        "vary",
      ].includes(name),
    ),
  );
}

function cachedResponse(row: { body: string; headers: string; fetched_at: number }) {
  const headers = new Headers(JSON.parse(row.headers));
  const priorAge = Number(headers.get("age") ?? 0);
  headers.set(
    "Age",
    String(Math.floor(Math.max(0, priorAge) + (Date.now() - row.fetched_at) / 1000)),
  );
  return new Response(row.body, { headers });
}
