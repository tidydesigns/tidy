import type { $ZodConfig } from "zod/v4/core";

type Factory = NonNullable<$ZodConfig["staticObjectParser"]>;
let factory: Factory | undefined;

export const registeredObjectParser: Factory = (shape, inst, memo) => factory?.(shape, inst, memo);
export function registerObjectParser(value: Factory) {
  factory = value;
}
