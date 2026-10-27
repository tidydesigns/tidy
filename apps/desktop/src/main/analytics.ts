import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ANALYTICS_NOTICE,
  analyticsChoicesSchema,
  analyticsEnvelopeSchema,
  analyticsEventSchema,
  analyticsPurpose,
  analyticsReceiptSchema,
  essentialAnalytics,
  type AnalyticsAPI,
  type AnalyticsChoices,
  type AnalyticsEnvelope,
  type AnalyticsEvent,
  type AnalyticsReceipt,
  type AnalyticsState,
} from "@tidy/design/analytics";
import type { PrivateState } from "./platform/private-state";

const savedSchema = z
  .object({
    notice: z.literal(ANALYTICS_NOTICE),
    choices: analyticsChoicesSchema,
    expiresAt: z.iso.datetime(),
    receipt: analyticsReceiptSchema.optional(),
    erase: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
    activeDay: z.string().optional(),
    target: z.object({ from: z.string(), to: z.string() }).optional(),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
/** Optional analytics owns no project access, cloud tokens, content or raw exceptions. */
export class DesktopAnalytics implements AnalyticsAPI {
  private saved: Saved = {
    notice: ANALYTICS_NOTICE,
    choices: { ...essentialAnalytics },
    expiresAt: new Date(0).toISOString(),
    erase: [],
  };
  private events: AnalyticsEnvelope[] = [];
  private work = Promise.resolve();
  private writes = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private controllers = new Set<AbortController>();
  private registration?: Promise<AnalyticsReceipt | undefined>;
  private generation = 0;
  private closed = false;
  private ready = false;
  private initialized = false;
  private listeners = new Set<(state: AnalyticsState) => void>();
  private refreshing?: Promise<void>;
  private flushing = false;
  private localErrors: { at: string; event: AnalyticsEvent }[] = [];
  private lastError = new Map<string, number>();
  private lastSync = new Map<string, number>();
  constructor(
    private options: {
      state: PrivateState;
      origin: string;
      version: string;
      platform: string;
      arch: string;
      available: boolean;
      fetch(input: string, init?: RequestInit): Promise<Response>;
      open(url: string): Promise<unknown>;
      now?: () => number;
    },
  ) {
    const origin = new URL(options.origin);
    if (
      origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )
    )
      throw new Error("Invalid analytics origin.");
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("Invalid analytics origin.");
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private permitted(purpose: keyof AnalyticsChoices) {
    return (
      this.ready &&
      !this.closed &&
      this.options.available &&
      this.saved.choices[purpose] &&
      Date.parse(this.saved.expiresAt) > this.now()
    );
  }
  async initialize() {
    try {
      await this.options.state.initialize();
      this.initialized = true;
      const raw = await this.options.state.read("choices");
      const parsed = savedSchema.safeParse(raw);
      if (parsed.success) this.saved = parsed.data;
      else if (raw && typeof raw === "object") {
        // A changed notice must revoke collection without losing the ability to erase old reports.
        const prior = raw as Record<string, unknown>;
        const token = z.string().regex(/^[a-f0-9]{64}$/);
        const receipt = z.object({ token }).safeParse(prior.receipt);
        const erased = z.array(token).max(1000).safeParse(prior.erase);
        this.saved.erase = [
          ...new Set([
            ...(erased.success ? erased.data : []),
            ...(receipt.success ? [receipt.data.token] : []),
          ]),
        ];
        await this.persist();
      }
      await this.pruneLocal();
      // Outdated notices and malformed records never grant optional collection.
      this.ready = true;
      if (this.saved.receipt && Date.parse(this.saved.expiresAt) <= this.now())
        await this.choose({ ...essentialAnalytics });
      if (this.saved.erase.length || this.permitted("usage") || this.permitted("diagnostics"))
        this.schedule();
    } catch {
      this.ready = false;
    }
    this.notify();
  }
  subscribe(listener: (state: AnalyticsState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* A closed renderer cannot change consent. */
      }
    }
  }
  private snapshot(): AnalyticsState {
    const valid = Date.parse(this.saved.expiresAt) > this.now();
    return {
      notice: ANALYTICS_NOTICE,
      available: this.options.available && this.initialized,
      usage: valid && this.saved.choices.usage,
      diagnostics: valid && this.saved.choices.diagnostics,
      expiresAt: valid ? this.saved.expiresAt : null,
      linked: valid && Boolean(this.saved.receipt?.linked),
      pendingDeletion: this.saved.erase.length > 0,
      reference: this.privacyReference(),
    };
  }
  /** A support lookup reference cannot authorize the bearer-receipt endpoints. */
  private privacyReference() {
    const token = this.saved.receipt?.token ?? this.saved.erase[0];
    return token ? createHash("sha256").update(token).digest("hex") : null;
  }
  async state(): Promise<AnalyticsState> {
    return this.snapshot();
  }
  private persist() {
    const value = structuredClone(this.saved);
    const next = this.writes.catch(() => {}).then(() => this.options.state.write("choices", value));
    this.writes = next;
    return next;
  }
  async choose(input: AnalyticsChoices) {
    const choices = analyticsChoicesSchema.parse(input);
    if (
      this.ready &&
      Date.parse(this.saved.expiresAt) > this.now() &&
      choices.usage === this.saved.choices.usage &&
      choices.diagnostics === this.saved.choices.diagnostics
    )
      return this.state();
    return this.replaceChoices(choices);
  }
  private async replaceChoices(choices: AnalyticsChoices) {
    const generation = ++this.generation;
    for (const controller of this.controllers) controller.abort();
    this.events = [];
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saved.receipt) this.saved.erase.push(this.saved.receipt.token);
    this.saved = {
      notice: ANALYTICS_NOTICE,
      choices,
      expiresAt: new Date(this.now() + 90 * 86_400_000).toISOString(),
      erase: [...new Set(this.saved.erase)],
    };
    // Persist the decision before any capture or network request can use it.
    this.ready = false;
    try {
      await this.persist();
      if (generation === this.generation) this.ready = true;
    } catch {
      if (generation === this.generation) {
        this.saved.choices = { ...essentialAnalytics };
        this.notify();
        if (this.saved.erase.length) this.schedule();
      }
      throw new Error("Could not store the privacy choice. Sharing stays off.");
    }
    this.notify();
    this.active();
    if (this.saved.erase.length || this.permitted("usage") || this.permitted("diagnostics"))
      this.schedule();
    return this.state();
  }
  private async request(action: string, body: unknown, token?: string) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.options.fetch(
        new URL(`/api/telemetry/desktop/${action}`, this.options.origin).href,
        {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      // Keep the deadline and cancellation active through body consumption, not only headers.
      const reader = response.body?.getReader();
      if (!reader) return response;
      const limit = action === "export" ? 5_000_000 : 16_384;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let rejectAbort: (error: unknown) => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const cancel = () => {
        rejectAbort(controller.signal.reason);
        void reader.cancel(controller.signal.reason).catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        controller.signal.throwIfAborted();
        for (;;) {
          const value = await Promise.race([reader.read(), aborted]);
          controller.signal.throwIfAborted();
          if (value.done) break;
          size += value.value.byteLength;
          if (size > limit) throw new Error("Privacy response too large.");
          chunks.push(value.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new Response(bytes, { status: response.status, headers: response.headers });
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  private schedule(delay = 250) {
    if (this.closed || !this.options.available || this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.work = this.work
        .catch(() => {})
        .then(() => this.flush())
        .catch(() => {});
    }, delay);
    this.timer.unref?.();
  }
  private ensureReceipt(): Promise<AnalyticsReceipt | undefined> {
    return (this.registration ??= this.register().finally(() => {
      this.registration = undefined;
    }));
  }
  private async register(): Promise<AnalyticsReceipt | undefined> {
    if (this.saved.receipt) return this.saved.receipt;
    if (this.saved.erase.length) return;
    if (!this.permitted("usage") && !this.permitted("diagnostics")) return;
    const generation = this.generation;
    const response = await this.request("receipt", {
      notice: ANALYTICS_NOTICE,
      choices: this.saved.choices,
    });
    if (!response.ok) throw new Error("Optional collection unavailable.");
    const raw = (await response.json()) as Record<string, unknown>;
    const { token, revision, expiresAt, linked } = analyticsReceiptSchema.parse({
      token: raw.token,
      revision: raw.revision,
      expiresAt: raw.expiresAt,
      linked: raw.linked,
    });
    if (generation !== this.generation || this.closed) {
      this.saved.erase = [...new Set([...this.saved.erase, token])];
      await this.persist();
      return;
    }
    this.saved.receipt = { token, revision, expiresAt, linked };
    await this.persist();
    this.notify();
    if (this.permitted("usage")) this.capture({ name: "desktop_first_seen" });
    return this.saved.receipt;
  }
  private async flush() {
    if (this.closed || this.flushing) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flushing = true;
    let failed = false;
    const generation = this.generation;
    let batch: AnalyticsEnvelope[] = [];
    let receipt: AnalyticsReceipt | undefined;
    try {
      for (const token of [...this.saved.erase]) {
        const response = await this.request("erase", {}, token);
        if (!response.ok && response.status !== 401) throw new Error("Erasure pending.");
        this.saved.erase = this.saved.erase.filter((value) => value !== token);
        await this.persist();
        this.notify();
      }
      if (generation !== this.generation || this.closed) return;
      receipt = await this.ensureReceipt();
      if (!receipt || generation !== this.generation || receipt !== this.saved.receipt) return;
      batch = this.events
        .splice(0, 25)
        .filter(
          (value) =>
            this.permitted(analyticsPurpose(value.event)) &&
            this.now() - Date.parse(value.at) < 86_400_000,
        );
      if (!batch.length) return;
      const response = await this.request(
        "events",
        { revision: receipt.revision, events: batch },
        receipt.token,
      );
      if (generation !== this.generation || this.closed) return;
      if (response.status === 409) {
        // Linking advances the server revision. Discard the earlier batch even if the device clock is ahead.
        await this.refresh();
        return;
      }
      if (response.status === 401) {
        await this.choose({ ...essentialAnalytics });
        return;
      }
      if (!response.ok) throw new Error("Optional delivery unavailable.");
    } catch {
      failed = true;
      // Retry the same delivery IDs after transport failures; never carry them across consent.
      if (!this.closed && generation === this.generation && receipt === this.saved.receipt)
        this.events = [...batch, ...this.events]
          .filter(
            (value) =>
              this.permitted(analyticsPurpose(value.event)) &&
              this.now() - Date.parse(value.at) < 86_400_000,
          )
          .slice(0, 100);
    } finally {
      const pending =
        this.saved.erase.length ||
        this.events.length ||
        (!this.saved.receipt && (this.permitted("usage") || this.permitted("diagnostics")));
      this.flushing = false;
      if (!this.closed && pending)
        this.schedule(failed && generation === this.generation ? 60_000 : 250);
    }
  }
  capture(input: AnalyticsEvent) {
    const event = analyticsEventSchema.parse(input);
    if (!this.permitted(analyticsPurpose(event))) return;
    // Sync can acknowledge every editing batch. Report health, not a stream of edits.
    if (event.name === "desktop_sync_result") {
      if (this.now() - (this.lastSync.get(event.result) ?? 0) < 60_000) return;
      this.lastSync.set(event.result, this.now());
    }
    const envelope = analyticsEnvelopeSchema.safeParse({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      release: this.options.version,
      platform: this.options.platform,
      arch: ["arm64", "x64"].includes(this.options.arch) ? this.options.arch : "other",
      event,
    });
    if (!envelope.success || this.events.length >= 100) return;
    this.events.push(envelope.data);
    this.schedule();
  }
  /** Native error categories stay available locally, independently of optional uploads. */
  record(input: AnalyticsEvent) {
    const event = analyticsEventSchema.parse(input);
    if (event.name === "desktop_error") return this.error(event.operation);
    if (event.name === "desktop_sync_result" && event.result === "failed") this.error("sync");
    this.capture(event);
  }
  bind() {
    const generation = this.generation;
    return (event: AnalyticsEvent) => {
      if (generation === this.generation) this.record(event);
    };
  }
  active(isActive: () => boolean = () => true) {
    if (!this.permitted("usage")) return;
    if (!isActive()) return;
    const day = `${new Date(this.now()).toISOString().slice(0, 10)}:${this.options.version}`;
    if (this.saved.activeDay === day) return;
    this.saved.activeDay = day;
    this.capture({ name: "product_active_day" });
    void this.persist().catch(() => {});
  }
  error(operation: Extract<AnalyticsEvent, { name: "desktop_error" }>["operation"]) {
    if (this.now() - (this.lastError.get(operation) ?? 0) < 60_000) return;
    this.lastError.set(operation, this.now());
    const event: AnalyticsEvent = { name: "desktop_error", operation, category: "unexpected" };
    this.localErrors.push({ at: new Date(this.now()).toISOString(), event });
    this.localErrors = this.localErrors
      .filter((value) => this.now() - Date.parse(value.at) < 7 * 86_400_000)
      .slice(-100);
    const value = structuredClone(this.localErrors);
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.options.state.write("diagnostics", value))
      .catch(() => {});
    this.capture(event);
  }
  async pruneLocal() {
    const schema = z
      .array(z.object({ at: z.iso.datetime(), event: analyticsEventSchema }).strict())
      .max(100);
    const parsed = schema.safeParse(await this.options.state.read("diagnostics"));
    if (!parsed.success) {
      await this.options.state.remove("diagnostics");
      return;
    }
    this.localErrors = parsed.data.filter(
      (value) =>
        value.event.name === "desktop_error" && this.now() - Date.parse(value.at) < 7 * 86_400_000,
    );
    if (this.localErrors.length) await this.options.state.write("diagnostics", this.localErrors);
    else await this.options.state.remove("diagnostics");
  }
  async link() {
    const generation = this.generation;
    const receipt = await this.ensureReceipt();
    if (
      !receipt ||
      generation !== this.generation ||
      receipt !== this.saved.receipt ||
      !this.permitted("usage")
    )
      throw new Error("Enable usage statistics before linking.");
    const response = await this.request("link", {}, receipt.token);
    if (!response.ok) throw new Error("Could not start account linking.");
    const value = z
      .object({ url: z.url() })
      .strict()
      .parse(await response.json());
    if (
      generation !== this.generation ||
      receipt !== this.saved.receipt ||
      !this.permitted("usage")
    )
      throw new Error("Privacy choices changed. Start linking again.");
    const url = new URL(value.url);
    if (
      url.origin !== new URL(this.options.origin).origin ||
      url.pathname !== "/privacy/desktop-link" ||
      !/^\?challenge=[a-f0-9]{64}$/.test(url.search)
    )
      throw new Error("Invalid link destination.");
    await this.options.open(url.href);
  }
  refresh() {
    return (this.refreshing ??= this.refreshState().finally(() => {
      this.refreshing = undefined;
    }));
  }
  private async refreshState() {
    const receipt = this.saved.receipt;
    if (!receipt || (!this.permitted("usage") && !this.permitted("diagnostics"))) return;
    const generation = this.generation;
    try {
      const response = await this.request("status", {}, receipt.token);
      if (!response.ok) return;
      const value = (await response.json()) as Record<string, unknown>;
      if (generation !== this.generation || receipt !== this.saved.receipt || this.closed) return;
      const next = analyticsReceiptSchema.parse({
        token: value.token,
        revision: value.revision,
        expiresAt: value.expiresAt,
        linked: value.linked,
      });
      if (next.token !== receipt.token) return;
      if (next.linked !== receipt.linked || next.revision !== receipt.revision) {
        this.generation++;
        this.events = [];
        delete this.saved.activeDay;
      }
      const choices = analyticsChoicesSchema.parse(value.choices);
      this.saved.choices = {
        usage: this.saved.choices.usage && choices.usage,
        diagnostics: this.saved.choices.diagnostics && choices.diagnostics,
      };
      this.saved.expiresAt = new Date(
        Math.min(Date.parse(this.saved.expiresAt), Date.parse(next.expiresAt)),
      ).toISOString();
      this.saved.receipt = next;
      await this.persist();
      this.active();
      this.notify();
    } catch {}
  }
  async unlink() {
    // Rotate locally at once, even offline. Old reports are erased by the durable retry queue.
    return this.replaceChoices({ ...this.saved.choices });
  }
  async erase() {
    await this.choose({ ...essentialAnalytics });
    this.localErrors = [];
    await this.options.state.remove("diagnostics");
    return this.state();
  }
  async reports() {
    const generation = this.generation;
    const localDiagnostics = this.localErrors.filter(
      (value) => this.now() - Date.parse(value.at) < 7 * 86_400_000,
    );
    const receipt = this.saved.receipt;
    if (!receipt) return JSON.stringify({ formatVersion: 1, events: [], localDiagnostics });
    const response = await this.request("export", {}, receipt.token);
    if (!response.ok)
      throw new Error(
        "Could not download reports. Contact the operator if your export is too large.",
      );
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error("Report export too large.");
    if (generation !== this.generation || receipt !== this.saved.receipt)
      throw new Error("Privacy choices changed. Download reports again.");
    return JSON.stringify({ ...JSON.parse(text), localDiagnostics });
  }
  async updateTarget(target: string) {
    if (!this.permitted("diagnostics")) return;
    this.saved.target = { from: this.options.version, to: target };
    await this.persist();
  }
  async confirmUpdate() {
    const generation = this.generation;
    const target = this.saved.target;
    if (!target) return;
    delete this.saved.target;
    await this.persist();
    if (generation === this.generation && target.to === this.options.version)
      this.capture({
        name: "desktop_update_result",
        stage: "install",
        result: "success",
        from: target.from,
        to: this.options.version,
      });
  }
  async policy() {
    await this.options.open(new URL("/privacy", this.options.origin).href);
  }
  async reportError() {
    this.error("renderer");
  }
  async performance(duration: "under_100ms" | "under_1s" | "under_5s" | "over_5s") {
    this.capture({ name: "desktop_performance", operation: "interaction", duration });
  }
  close() {
    this.closed = true;
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    clearTimeout(this.timer);
    this.events = [];
    this.listeners.clear();
    return this.writes.catch(() => {});
  }
}
