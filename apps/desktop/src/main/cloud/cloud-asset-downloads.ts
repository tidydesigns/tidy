type Download = {
  key: string;
  owner: string;
  controller: AbortController;
  load(signal: AbortSignal): Promise<string>;
  result: ReturnType<typeof Promise.withResolvers<string>>;
};

export class CloudAssetDownloads {
  private jobs = new Map<string, Download>();
  private active = new Set<Download>();
  private foreground = new Set<Download>();
  private background = new Set<Download>();
  private stopped = false;

  run(owner: string, assetId: string, foreground: boolean, load: Download["load"]) {
    if (this.stopped) return Promise.reject(new Error("Cloud downloads are stopped."));
    const key = `${owner}:${assetId}`;
    const existing = this.jobs.get(key);
    if (existing) {
      if (foreground && this.background.delete(existing)) this.foreground.add(existing);
      this.pump();
      return existing.result.promise;
    }
    const job: Download = {
      key,
      owner,
      controller: new AbortController(),
      load,
      result: Promise.withResolvers<string>(),
    };
    this.jobs.set(key, job);
    (foreground ? this.foreground : this.background).add(job);
    this.pump();
    return job.result.promise;
  }

  private pump() {
    if (this.stopped) return;
    while (this.active.size < 4) {
      const job =
        this.foreground.values().next().value ??
        (this.active.size < 3 ? this.background.values().next().value : undefined);
      if (!job) break;
      this.foreground.delete(job);
      this.background.delete(job);
      this.active.add(job);
      void Promise.resolve()
        .then(() => {
          job.controller.signal.throwIfAborted();
          return job.load(job.controller.signal);
        })
        .then(job.result.resolve, job.result.reject)
        .finally(() => {
          this.jobs.delete(job.key);
          this.active.delete(job);
          this.pump();
        });
    }
  }

  async cancel(owner: string) {
    const jobs = [...this.jobs.values()].filter((job) => job.owner === owner);
    for (const job of jobs) {
      job.controller.abort();
      if (!this.active.has(job)) {
        this.jobs.delete(job.key);
        this.foreground.delete(job);
        this.background.delete(job);
        job.result.reject(new Error("Cloud download was cancelled."));
      }
    }
    await Promise.allSettled(jobs.map((job) => job.result.promise));
  }

  async stop() {
    this.stopped = true;
    await Promise.all(
      [...new Set([...this.jobs.values()].map((job) => job.owner))].map((owner) =>
        this.cancel(owner),
      ),
    );
  }
}
