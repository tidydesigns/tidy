type Entry = { promise: Promise<string>; bytes: number };

/** Reuse public immutable font bytes without retaining local/private font data. */
export function createEmbeddedFontCache(
  read: (url: string) => Promise<string>,
  { maxEntries = 64, maxBytes = 8 * 1024 * 1024 } = {},
) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  const remove = (url: string) => {
    bytes -= entries.get(url)!.bytes;
    entries.delete(url);
  };
  return (url: string): Promise<string> => {
    const cached = entries.get(url);
    if (cached) {
      entries.delete(url);
      entries.set(url, cached);
      return cached.promise;
    }
    const entry: Entry = { promise: Promise.resolve(""), bytes: 0 };
    entry.promise = Promise.resolve()
      .then(() => read(url))
      .then(
        (data) => {
          if (entries.get(url) === entry) {
            // Conservatively account for UTF-16 strings and their URL keys.
            const retained = 2 * (url.length + data.length);
            if (retained > maxBytes) {
              remove(url);
              return data;
            }
            entry.bytes = retained;
            bytes += entry.bytes;
            while (bytes > maxBytes) remove(entries.keys().next().value!);
          }
          return data;
        },
        (error) => {
          if (entries.get(url) === entry) remove(url);
          throw error;
        },
      );
    entries.set(url, entry);
    while (entries.size > maxEntries) remove(entries.keys().next().value!);
    return entry.promise;
  };
}
