import { afterEach, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { staticObjectParser } from "./schema-object-parsers";
import { objectParserFactories } from "./schema-object-parsers.generated.js";

const previous = { ...z.config() };
afterEach(() =>
  z.config({
    ...previous,
    jitless: previous.jitless,
    memoizer: previous.memoizer,
    staticObjectParser: previous.staticObjectParser,
  }),
);

test("prebuilt object parsers remain synchronized with source schemas and the locked compiler", () => {
  execFileSync("bun", [
    "--no-env-file",
    `${import.meta.dir}/../scripts/generate-schema-object-parsers.mjs`,
    "--check",
  ]);
});

function outcome(schema: z.ZodType, input: unknown, abortEarly = false) {
  const context: z.core.ParseContextInternal<z.core.$ZodIssue> = { abortEarly };
  const parsed = schema.safeParse(input, context);
  return parsed.success ? { data: parsed.data } : { issues: parsed.error.issues };
}

test("every emitted object layout preserves defaults, refinements, transformations and errors", () => {
  for (const signature of objectParserFactories.keys()) {
    const [memo, keys] = JSON.parse(signature) as [
      boolean,
      [string, string | null, string | null][],
    ];
    expect(memo).toBe(true);
    const shape: Record<string, z.ZodType> = {};
    for (const [key, optin, optout] of keys) {
      let value: z.ZodType = z
        .number()
        .min(0)
        .transform((number) => number + 1);
      if (optin === "defaulted") value = value.default(3);
      else if (optin === "optional") value = value.optional();
      // Exercise emitted code against the original layout flags, including flags
      // that ordinary public combinators do not produce for this test's scalar.
      value._zod.optin = optin as typeof value._zod.optin;
      value._zod.optout = optout as typeof value._zod.optout;
      if (optin === null) delete value._zod.optin;
      if (optout === null) delete value._zod.optout;
      Object.defineProperty(shape, key, { value, enumerable: true, configurable: true });
    }
    z.config({ jitless: false, staticObjectParser: undefined });
    const original = z.object(shape);
    const parserFactory = mock(staticObjectParser);
    z.config({ jitless: true, staticObjectParser: parserFactory });
    const prebuilt = z.object(shape);
    expect(staticObjectParser(shape, prebuilt, z.config().memoizer)).toBeDefined();
    const complete = Object.fromEntries(keys.map(([key]) => [key, 2]));
    const invalid = Object.fromEntries(keys.map(([key]) => [key, -1]));
    for (const input of [complete, invalid, {}, null, [], { ...complete, extra: true }]) {
      for (const abortEarly of [false, true])
        expect(outcome(prebuilt, input, abortEarly)).toEqual(outcome(original, input, abortEarly));
    }
    expect(parserFactory).toHaveBeenCalledWith(shape, prebuilt, z.config().memoizer);
  }
});

test("prebuilt parsers preserve strict and passthrough objects, async work and fallback layouts", async () => {
  const shape = { x: z.number(), y: z.number(), width: z.number(), height: z.number() };
  const input = { x: 1, y: 2, width: 3, height: 4, extra: "kept" };
  for (const mode of ["strict", "loose", "catchall"] as const) {
    const build = () =>
      mode === "strict"
        ? z.strictObject(shape)
        : mode === "loose"
          ? z.looseObject(shape)
          : z.object(shape).catchall(z.string());
    z.config({ jitless: false, staticObjectParser: undefined });
    const original = build();
    z.config({ jitless: true, staticObjectParser });
    const prebuilt = build();
    expect(outcome(prebuilt, input)).toEqual(outcome(original, input));
    expect(await prebuilt.safeParseAsync(input)).toEqual(await original.safeParseAsync(input));
  }
  const symbol = Symbol("field");
  const symbolic = z.object({ [symbol]: z.string() });
  expect(staticObjectParser(symbolic.shape, symbolic, z.config().memoizer)).toBeUndefined();
  expect(symbolic.parse({ [symbol]: "value" })[symbol]).toBe("value");
  const unknown = z.object({ unmatchedFixtureField: z.number().default(5) });
  expect(unknown.parse({})).toEqual({ unmatchedFixtureField: 5 });
  const asynchronous = z.object({ ...shape, x: z.number().transform(async (value) => value + 1) });
  expect(await asynchronous.parseAsync(input)).toEqual({ x: 2, y: 2, width: 3, height: 4 });
});
