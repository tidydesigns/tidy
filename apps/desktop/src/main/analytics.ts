import { randomUUID } from "node:crypto";
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
    expiresAt: z.string(),
    receipt: analyticsReceiptSchema.optional(),
    erase: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10),
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
      const raw = await this.options.state.read("choices");
      const parsed = savedSchema.safeParse(raw);
      if (parsed.success) this.saved = parsed.data;
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
  }
  async state(): Promise<AnalyticsState> {
    const valid = Date.parse(this.saved.expiresAt) > this.now();
    return {
      notice: ANALYTICS_NOTICE,
      available: this.options.available && this.ready,
      usage: valid && this.saved.choices.usage,
      diagnostics: valid && this.saved.choices.diagnostics,
      expiresAt: valid ? this.saved.expiresAt : null,
      linked: valid && Boolean(this.saved.receipt?.linked),
    };
  }
  private persist() {
    const value = structuredClone(this.saved);
    const next = this.writes.catch(() => {}).then(() => this.options.state.write("choices", value));
    this.writes = next;
    return next;
  }
  async choose(input: AnalyticsChoices) {
    const choices = analyticsChoicesSchema.parse(input);
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
      erase: [...new Set(this.saved.erase)].slice(-10),
    };
    // Persist the decision before any capture or network request can use it.
    this.ready = false;
    try {
      await this.persist();
      if (generation === this.generation) this.ready = true;
    } catch {
      this.saved.choices = { ...essentialAnalytics };
      throw new Error("Could not store the privacy choice. Sharing stays off.");
    }
    this.active();
    this.schedule();
    return this.state();
  }
  private async request(action: string, body: unknown, token?: string) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      return await this.options.fetch(
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
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  private schedule() {
    if (this.closed || !this.options.available || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.work = this.work
        .catch(() => {})
        .then(() => this.flush())
        .catch(() => {});
    }, 250);
    this.timer.unref?.();
  }
  private ensureReceipt(): Promise<AnalyticsReceipt | undefined> {
    return (this.registration ??= this.register().finally(() => {
      this.registration = undefined;
    }));
  }
  private async register(): Promise<AnalyticsReceipt | undefined> {
    if (this.saved.receipt) return this.saved.receipt;
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
      this.saved.erase.push(token);
      await this.persist();
      return;
    }
    this.saved.receipt = { token, revision, expiresAt, linked };
    await this.persist();
    if (this.permitted("usage")) this.capture({ name: "desktop_first_seen" });
    return this.saved.receipt;
  }
  private async flush() {
    if (this.closed) return;
    try {
      for (const token of [...this.saved.erase]) {
        const response = await this.request("erase", {}, token);
        if (!response.ok && response.status !== 401) throw new Error("Erasure pending.");
        this.saved.erase = this.saved.erase.filter((value) => value !== token);
        await this.persist();
      }
      const receipt = await this.ensureReceipt();
      if (!receipt) return;
      const generation = this.generation;
      const batch = this.events
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
      if (response.status === 401) {
        this.saved.choices = { ...essentialAnalytics };
        this.events = [];
        await this.persist();
        return;
      }
      if (!response.ok && generation === this.generation)
        this.events = [...batch, ...this.events].slice(0, 100);
    } catch {
      /* Optional network delivery never fails a user interaction. */
    } finally {
      const pending =
        this.saved.erase.length ||
        this.events.length ||
        (!this.saved.receipt && (this.permitted("usage") || this.permitted("diagnostics")));
      if (!this.closed && pending) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.schedule();
        }, 60_000);
        this.timer.unref?.();
      }
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
    const receipt = await this.ensureReceipt();
    if (!receipt || !this.permitted("usage"))
      throw new Error("Enable usage statistics before linking.");
    const response = await this.request("link", {}, receipt.token);
    if (!response.ok) throw new Error("Could not start account linking.");
    const value = z
      .object({ url: z.url() })
      .strict()
      .parse(await response.json());
    const url = new URL(value.url);
    if (
      url.origin !== new URL(this.options.origin).origin ||
      url.pathname !== "/privacy/desktop-link" ||
      !/^\?challenge=[a-f0-9]{64}$/.test(url.search)
    )
      throw new Error("Invalid link destination.");
    await this.options.open(url.href);
  }
  async refresh() {
    const receipt = this.saved.receipt;
    if (!receipt || !this.permitted("usage")) return;
    const generation = this.generation;
    try {
      const response = await this.request("status", {}, receipt.token);
      if (response.ok && generation === this.generation) {
        const value = (await response.json()) as Record<string, unknown>;
        this.saved.receipt = analyticsReceiptSchema.parse({
          token: value.token,
          revision: value.revision,
          expiresAt: value.expiresAt,
          linked: value.linked,
        });
        await this.persist();
      }
    } catch {}
  }
  async unlink() {
    const receipt = this.saved.receipt;
    if (receipt) {
      const response = await this.request("unlink", {}, receipt.token);
      if (!response.ok) throw new Error("Could not remove account linking. Retry when online.");
      await this.refresh();
    }
    return this.state();
  }
  async erase() {
    await this.choose({ ...essentialAnalytics });
    this.localErrors = [];
    await this.options.state.remove("diagnostics");
    return this.state();
  }
  async reports() {
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
    return JSON.stringify({ ...JSON.parse(text), localDiagnostics });
  }
  async updateTarget(target: string) {
    if (!this.permitted("diagnostics")) return;
    this.saved.target = { from: this.options.version, to: target };
    await this.persist();
  }
  async confirmUpdate() {
    const target = this.saved.target;
    if (!target) return;
    delete this.saved.target;
    await this.persist();
    if (target.to === this.options.version)
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
    return this.writes.catch(() => {});
  }
}
