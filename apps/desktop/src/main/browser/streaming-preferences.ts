import { browserStreamingChoiceSchema } from "../../shared/contracts/browser-streaming";
import type { PrivateState } from "../platform/private-state";

export class BrowserStreamingPreferences {
  enabled = process.env.TIDY_BROWSER_STREAMING === "voxl";
  private loading?: Promise<void>;
  private writing = Promise.resolve();

  constructor(private readonly storage?: () => PrivateState) {}

  initialize() {
    return (this.loading ??= (async () => {
      const stored = await this.storage?.().read("browser-streaming");
      if (stored === undefined) return;
      const parsed = browserStreamingChoiceSchema.safeParse(stored);
      this.enabled = parsed.success ? parsed.data.enabled : false;
    })().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    }));
  }

  choose(enabled: boolean) {
    const update = this.writing.then(async () => {
      await this.initialize();
      if (enabled && process.platform !== "linux")
        throw new Error("Video streaming currently requires a Linux browser host.");
      await this.storage?.().write("browser-streaming", { enabled });
      this.enabled = enabled;
    });
    this.writing = update.catch(() => {});
    return update;
  }
}
