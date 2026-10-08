import { getCloudflareContext } from "@opennextjs/cloudflare";

const requests = new WeakMap<object, Map<string, Promise<unknown>>>();
/** Share readiness work within a Worker request; never retain private results globally. */
export function requestWork<T>(key: string, run: () => Promise<T>): Promise<T> {
  let context: object;
  try {
    context = getCloudflareContext().ctx;
  } catch {
    return run();
  }
  let work = requests.get(context);
  if (!work) {
    work = new Map();
    requests.set(context, work);
  }
  const existing = work.get(key);
  if (existing) return existing as Promise<T>;
  const result = run();
  work.set(key, result);
  void result.catch(() => work!.delete(key));
  return result;
}
