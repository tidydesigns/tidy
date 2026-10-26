import type { $ZodConfig } from "zod/v4/core";
import { objectParserKey } from "./schema-object-parser-key";
import { objectParserFactories } from "./schema-object-parsers.generated.js";

/** Unknown layouts retain Zod's interpreter, including async and symbol-keyed schemas. */
export const staticObjectParser: NonNullable<$ZodConfig["staticObjectParser"]> = (
  shape,
  inst,
  memo,
) => {
  const key = objectParserKey(shape, memo);
  if (key === undefined) return undefined;
  return objectParserFactories.get(key)?.(shape, inst, memo);
};
