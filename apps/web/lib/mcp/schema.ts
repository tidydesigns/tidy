import * as z from "zod";

const schemas = new Map<string, z.ZodType>();

/** Only static, deployment-owned schemas belong here. Never cache handlers,
 * grants, tool results or schemas derived from a caller's input. */
export function mcpSchema<T extends z.ZodType>(name: string, build: () => T): T {
  const existing = schemas.get(name);
  if (existing) return existing as T;
  const schema = build();
  const standard = schema["~standard"];
  const conversion = standard.jsonSchema;
  // The SDK converts schemas both for discovery and before dispatch. Share the
  // Standard Schema conversion, while retaining Zod's exact runtime validator.
  const cached = (io: "input" | "output") => {
    const results = new Map<string, ReturnType<typeof conversion.input>>();
    return (options: Parameters<typeof conversion.input>[0]) => {
      const key = JSON.stringify(options);
      let result = results.get(key);
      if (!result) {
        // Local $defs keep repeated node/style schemas from multiplying the
        // discovery payload. No remote references or permissive validators.
        result =
          options.target === "draft-2020-12"
            ? z.toJSONSchema(schema, { target: "draft-2020-12", io, reused: "ref" })
            : conversion[io](options);
        results.set(key, result);
      }
      return result;
    };
  };
  Object.defineProperty(standard, "jsonSchema", {
    value: { input: cached("input"), output: cached("output") },
  });
  schemas.set(name, schema);
  return schema;
}
