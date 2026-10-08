import { S3Client } from "bun";

/** Operator adapter; this module is never imported by application request handlers. */
export function createReconciliationBucket(options: ConstructorParameters<typeof S3Client>[0]) {
  const bucket = new S3Client(options);
  return {
    list: (input: Parameters<S3Client["list"]>[0]) => bucket.list(input),
    head: async (key: string) => {
      try {
        return await bucket.stat(key);
      } catch (error) {
        // Never classify authentication/network errors as a missing object.
        if (error && typeof error === "object" && "code" in error && error.code === "NoSuchKey")
          return null;
        throw error;
      }
    },
    delete: (key: string) => bucket.delete(key),
  };
}
