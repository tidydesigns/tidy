import { z } from "zod";

/** Parse only fields owned by the consumer; successful writes are never retried here. */
export async function readJsonResponse<T>({
  response,
  schema,
  message,
}: {
  response: Response;
  schema: z.ZodType<T>;
  message: string;
}): Promise<T> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(value);
    throw new Error(error.success ? error.data.error : message);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}
