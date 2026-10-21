import { z } from "zod";
import { UserFacingError } from "@tidy/ui/errors";

export class ResponseError extends Error {
  constructor(
    readonly response: Response,
    readonly body: unknown,
    options?: ErrorOptions,
  ) {
    super(`HTTP ${response.status}`, options);
    this.name = "ResponseError";
  }
}

/** Keep the parser failure and response when a server sends malformed JSON. */
export async function readJsonValue(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new UserFacingError(message, {
      cause: new ResponseError(response, undefined, { cause }),
    });
  }
}

export function responseError(response: Response, body: unknown, message: string) {
  const error = z.object({ error: z.string() }).safeParse(body);
  return new UserFacingError(
    response.status >= 400 && response.status < 500 && error.success ? error.data.error : message,
    {
      cause: new ResponseError(response, body),
    },
  );
}

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
  const value = await readJsonValue(response, message);
  if (!response.ok) {
    throw responseError(response, value, message);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new UserFacingError(message, { cause: result.error });
  return result.data;
}
