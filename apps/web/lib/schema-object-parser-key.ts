import type { $ZodConfig } from "zod/v4/core";

type Factory = NonNullable<$ZodConfig["staticObjectParser"]>;

/** Match only the exact object layout and optional-field semantics used at build time. */
export function objectParserKey(shape: Parameters<Factory>[0], memo: Parameters<Factory>[2]) {
  if (Object.getOwnPropertySymbols(shape).length) return undefined;
  return JSON.stringify([
    Boolean(memo),
    Object.keys(shape).map((key) => [
      key,
      shape[key]._zod.optin ?? null,
      shape[key]._zod.optout ?? null,
    ]),
  ]);
}
