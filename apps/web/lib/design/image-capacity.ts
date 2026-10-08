import { AsyncLocalStorage } from "node:async_hooks";
import { IMAGE_READ_LIMITS } from "@/lib/security/resource-limits";

const admitted = new AsyncLocalStorage<boolean>();
let active = 0;
export class ImageCapacityError extends Error {}

/** No waiting queue or retained bodies; nested services reuse their own slot.
 * This bounds server work per isolate, alongside persistent shared attempt limits. */
export async function withImageReadCapacity<T>(work: () => Promise<T>): Promise<T> {
  if (admitted.getStore()) return work();
  if (active >= IMAGE_READ_LIMITS.concurrentReads) throw new ImageCapacityError();
  active++;
  try {
    return await admitted.run(true, work);
  } finally {
    active--;
  }
}
