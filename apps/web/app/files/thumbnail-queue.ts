function queue(limit: number) {
  let active = 0;
  const waiting: { start: () => void; priority: () => number }[] = [];
  const drain = () => {
    while (active < limit && waiting.length) {
      let next = 0;
      for (let index = 1; index < waiting.length; index++) {
        if (waiting[index]!.priority() > waiting[next]!.priority()) next = index;
      }
      waiting.splice(next, 1)[0]!.start();
    }
  };
  return async function run<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
    priority: () => number = () => 0,
  ): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        active++;
        resolve();
      };
      const abort = () => {
        const index = waiting.findIndex((entry) => entry.start === start);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push({ start, priority });
      signal.addEventListener("abort", abort, { once: true });
      // Collect this observer/effect batch before assigning the available slots.
      queueMicrotask(drain);
    });
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      active--;
      drain();
    }
  };
}

/** Two snapshots can prepare concurrently; only one document scene can mount. */
export const prepareThumbnail = queue(2);
export const queueThumbnail = queue(1);
/** Persistence never holds a rendering slot or delays the displayed image. */
export const uploadThumbnail = queue(2);
