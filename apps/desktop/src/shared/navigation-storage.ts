import type { z } from "zod";

export type SessionValue = z.infer<ReturnType<typeof z.json>>;

export function readNavigation<T extends SessionValue>({
  storage,
  key,
  schema,
  fallback,
}: {
  storage: Pick<Storage, "getItem">;
  key: string;
  schema: z.ZodType<T>;
  fallback: T;
}): T {
  try {
    const parsed = schema.safeParse(
      JSON.parse(storage.getItem(`tidy:navigation:${key}`) ?? "null"),
    );
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function writeNavigation<T extends SessionValue>({
  storage,
  key,
  value,
}: {
  storage: Pick<Storage, "setItem">;
  key: string;
  value: T;
}) {
  try {
    storage.setItem(`tidy:navigation:${key}`, JSON.stringify(value));
  } catch {}
}
