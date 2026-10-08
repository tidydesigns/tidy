function queue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        active++;
        resolve();
      };
      const abort = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      if (active < limit) start();
      else {
        waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Two snapshots can prepare concurrently; only one document scene can mount. */
export const prepareThumbnail = queue(2);
export const queueThumbnail = queue(1);
/** Persistence never holds a rendering slot or delays the displayed image. */
export const uploadThumbnail = queue(2);
