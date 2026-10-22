import { validateCimdMetadata, validateClientIdUrl } from "@better-auth/cimd";

type CacheRow = {
  url: string;
  body: string;
  headers: string;
  fetched_at: number;
  expires_at: number;
};
type Counter = { count: number };
export type RateRule = { window: number; max: number; cost?: number };
export type RateCheck = { key: string; rule: RateRule };
export type RatePair = [RateCheck, RateCheck];
export type RateDecision = { allowed: boolean; retryAfter: number | null; atomicAdmission?: true };
export class AuthGuardLimit extends Error {}

class AdmissionDenied extends Error {
  constructor(readonly decision: RateDecision) {
    super("Admission denied.");
  }
}

// Only completed, validated public metadata is persisted. No sessions, grants,
// credentials, request objects, or pending promises are retained here.
export class AuthGuardStore {
  private bucketCount: number;
  private nextCleanupAt = 0;
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS auth_bucket (key TEXT PRIMARY KEY, count INTEGER NOT NULL, last_request INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS auth_bucket_expiry ON auth_bucket (expires_at)");
    this.bucketCount = sql
      .exec<Counter>("SELECT count(*) AS count FROM auth_bucket")
      .toArray()[0].count;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, headers TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata_fetch (id TEXT PRIMARY KEY, url TEXT NOT NULL, origin TEXT NOT NULL, started_at INTEGER NOT NULL, active_until INTEGER NOT NULL)",
    );
  }

  /** Fixed windows start with the first charge. Successful requests never extend
   * an active window. Existing stored counters keep their expiry on upgrade. */
  consume(key: string, rule: RateRule, now = Date.now()): RateDecision {
    const cost = rule.cost ?? 1;
    if (
      !Number.isSafeInteger(cost) ||
      cost < 1 ||
      cost > rule.max ||
      key.length > 256 ||
      !Number.isSafeInteger(rule.max) ||
      rule.max < 1 ||
      !Number.isFinite(rule.window) ||
      rule.window <= 0 ||
      rule.window > 3600
    )
      throw new Error("Invalid auth rate-limit rule.");
    // Indexed, bounded cleanup. Only this synchronous store mutates buckets,
    // so its cached row count stays exact and is reconstructed when an object wakes.
    if (now >= this.nextCleanupAt) {
      const removed = this.sql
        .exec(
          "DELETE FROM auth_bucket WHERE key IN (SELECT key FROM auth_bucket WHERE expires_at <= ? ORDER BY expires_at LIMIT 256) RETURNING key",
          now,
        )
        .toArray().length;
      this.bucketCount -= removed;
      this.nextCleanupAt = now + 1000;
    }
    const row = this.sql
      .exec<{ count: number; expires_at: number }>(
        "SELECT count, expires_at FROM auth_bucket WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (row && row.expires_at > now && row.count + cost > rule.max) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((row.expires_at - now) / 1000)),
      };
    }
    if (!row && this.bucketCount >= 10_000) return { allowed: false, retryAfter: 60 };
    const active = row && row.expires_at > now;
    const count = active ? row.count + cost : cost;
    const expiresAt = active ? row.expires_at : now + rule.window * 1000;
    this.sql.exec(
      "INSERT INTO auth_bucket (key, count, last_request, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, last_request = excluded.last_request, expires_at = excluded.expires_at",
      key,
      count,
      now,
      expiresAt,
    );
    if (!row) this.bucketCount++;
    return { allowed: true, retryAfter: null };
  }

  /** Ordered reservations: keep the first charge when the second denies.
   * Synchronous storage work cannot interleave between these two checks. */
  consumePair(first: RateCheck, second: RateCheck): RateDecision {
    const decision = this.consume(first.key, first.rule);
    return decision.allowed ? this.consume(second.key, second.rule) : decision;
  }

  /** Both allowances and identity allocation commit together. Restore cached
   * accounting as well as SQL state when the storage transaction rolls back. */
  consumeAdmission({
    identity,
    shared,
    transactionSync,
  }: {
    identity: RatePair;
    shared: RatePair;
    transactionSync: <T>(callback: () => T) => T;
  }): RateDecision {
    const bucketCount = this.bucketCount;
    const nextCleanupAt = this.nextCleanupAt;
    const now = Date.now();
    try {
      return transactionSync(() => {
        // Admission must reclaim expired rows even during bursts within one second.
        this.nextCleanupAt = 0;
        for (const { key, rule } of [...shared, ...identity]) {
          const decision = this.consume(key, rule, now);
          if (!decision.allowed) throw new AdmissionDenied(decision);
        }
        return { allowed: true, retryAfter: null };
      });
    } catch (error) {
      this.bucketCount = bucketCount;
      this.nextCleanupAt = nextCleanupAt;
      if (error instanceof AdmissionDenied) return error.decision;
      throw error;
    }
  }

  acquireFetch(url: string, now = Date.now()) {
    const error = validateClientIdUrl(url);
    if (error) throw new TypeError(error);
    this.sql.exec("DELETE FROM metadata_fetch WHERE started_at <= ?", now - 60_000);
    const origin = new URL(url).origin;
    const counts = this.sql
      .exec<{
        total: number;
        origin_total: number;
        active: number;
        origin_active: number;
        client_active: number;
      }>(
        "SELECT count(*) AS total, coalesce(sum(origin = ?), 0) AS origin_total, coalesce(sum(active_until > ?), 0) AS active, coalesce(sum(origin = ? AND active_until > ?), 0) AS origin_active, coalesce(sum(url = ? AND active_until > ?), 0) AS client_active FROM metadata_fetch",
        origin,
        now,
        origin,
        now,
        url,
        now,
      )
      .toArray()[0];
    if (
      counts.total >= 120 ||
      counts.origin_total >= 30 ||
      counts.active >= 16 ||
      counts.origin_active >= 4 ||
      counts.client_active > 0
    )
      throw new AuthGuardLimit("Metadata fetch limit exceeded.");
    const id = crypto.randomUUID();
    // A crashed invocation cannot permanently consume concurrency capacity.
    this.sql.exec(
      "INSERT INTO metadata_fetch VALUES (?, ?, ?, ?, ?)",
      id,
      url,
      origin,
      now,
      now + 6000,
    );
    return () => {
      this.sql.exec("UPDATE metadata_fetch SET active_until = 0 WHERE id = ?", id);
    };
  }

  cached(url: string, now = Date.now()) {
    const row = this.sql
      .exec<CacheRow>(
        "SELECT url, body, headers, fetched_at, expires_at FROM metadata_cache WHERE url = ?",
        url,
      )
      .toArray()[0];
    if (row) this.sql.exec("UPDATE metadata_cache SET accessed_at = ? WHERE url = ?", now, url);
    return row;
  }

  store(url: string, body: string, headers: Headers, now = Date.now()) {
    // The transport also fetches client-owned JWKS. Those never enter this
    // metadata cache; the OAuth provider performs its own JWKS validation.
    const invalidate = () => {
      this.sql.exec("DELETE FROM metadata_cache WHERE url = ?", url);
    };
    if (new TextEncoder().encode(body).byteLength > 5120) {
      invalidate();
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      invalidate();
      return;
    }
    if (!validateCimdMetadata(url, document, { metadataProfile: "mcp-2026-07-28" }).valid) {
      invalidate();
      return;
    }
    const lifetime = metadataFreshness(headers, now);
    if (lifetime <= 0) {
      this.sql.exec("DELETE FROM metadata_cache WHERE url = ?", url);
      return;
    }
    this.sql.exec("DELETE FROM metadata_cache WHERE fetched_at < ?", now - 86_400_000);
    const storedHeaders = JSON.stringify(
      [...headers.entries()].filter(([name]) =>
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
    this.sql.exec(
      "INSERT INTO metadata_cache VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET body = excluded.body, headers = excluded.headers, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, accessed_at = excluded.accessed_at",
      url,
      body,
      storedHeaders,
      now,
      now + lifetime,
      now,
    );
    this.sql.exec(
      "DELETE FROM metadata_cache WHERE url IN (SELECT url FROM metadata_cache ORDER BY accessed_at DESC LIMIT -1 OFFSET 1000)",
    );
  }
}

export function metadataFreshness(headers: Headers, now: number) {
  const control = headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-store|private|no-cache)(?:\s|=|,|$)/i.test(control)) return 0;
  const vary = headers.get("vary");
  if (vary && vary.split(",").some((name) => name.trim().toLowerCase() !== "accept")) return 0;
  const ages = new Map<string, number>();
  for (const directive of control.split(",").map((value) => value.trim())) {
    if (!/^(?:s-maxage|max-age)\b/i.test(directive)) continue;
    const matched = directive.match(/^(s-maxage|max-age)\s*=\s*(?:"(\d+)"|(\d+))$/i);
    if (!matched || ages.has(matched[1].toLowerCase())) return 0;
    const seconds = Number(matched[2] ?? matched[3]);
    if (!Number.isSafeInteger(seconds)) return 0;
    ages.set(matched[1].toLowerCase(), seconds);
  }
  const seconds = ages.get("s-maxage") ?? ages.get("max-age");
  const date = Date.parse(headers.get("date") ?? "");
  const ageHeader = Number(headers.get("age") ?? 0);
  const age = Math.max(
    Number.isFinite(ageHeader) && ageHeader >= 0 ? ageHeader * 1000 : 0,
    Number.isFinite(date) ? Math.max(0, now - date) : 0,
  );
  if (headers.has("age") && (!Number.isFinite(ageHeader) || ageHeader < 0)) return 0;
  if (seconds !== undefined) return Math.max(0, Math.min(600_000, seconds * 1000 - age));
  const expires = Date.parse(headers.get("expires") ?? "");
  if (Number.isFinite(expires))
    return Math.max(0, Math.min(600_000, expires - (Number.isFinite(date) ? date : now) - age));
  return Math.max(0, 600_000 - age);
}
