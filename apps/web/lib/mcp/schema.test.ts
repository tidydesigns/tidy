import { expect, test } from "bun:test";
import * as z from "zod";
import { mcpSchema } from "./schema";
import { isMcpReadOperation } from "./execution-policy";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

test("static MCP schemas reuse conversion without weakening runtime validation", () => {
  const child = z.object({ label: z.string().min(1), count: z.number().int().min(0) });
  const schema = mcpSchema("fixture-schema", () => z.object({ first: child, second: child }));
  const shape = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  expect(shape.$defs).toBeDefined();
  for (const provider of [new AjvJsonSchemaValidator(), new CfWorkerJsonSchemaValidator()]) {
    const validate = provider.getValidator(shape);
    expect(
      validate({ first: { label: "ok", count: 0 }, second: { label: "ok", count: 1 } }).valid,
    ).toBe(true);
    expect(
      validate({ first: { label: "", count: -1 }, second: { label: "ok", count: 1 } }).valid,
    ).toBe(false);
  }
  expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toBe(shape);
  expect(
    mcpSchema<typeof schema>("fixture-schema", () => {
      throw new Error("Rebuilt schema");
    }),
  ).toBe(schema);
  expect(
    schema.safeParse({ first: { label: "", count: -1 }, second: { label: "ok", count: 1 } })
      .success,
  ).toBe(false);
  expect(
    schema.safeParse({ first: { label: "ok", count: 0 }, second: { label: "ok", count: 1 } })
      .success,
  ).toBe(true);
});

test("unknown operations and mutations keep atomic write execution regardless of annotations", () => {
  for (const name of [
    "create_file",
    "patch_document",
    "validate_import",
    "get_review_context",
    "list_review_feedback",
    "linear_update_issue",
    "future_read_tool",
  ])
    expect(isMcpReadOperation({ kind: "tool", name })).toBe(false);
  for (const name of ["get_document", "get_file", "linear_list_teams"])
    expect(isMcpReadOperation({ kind: "tool", name })).toBe(true);
  expect(isMcpReadOperation({ kind: "resource", name: "design-file" })).toBe(true);
  expect(isMcpReadOperation({ kind: "resource", name: "unknown" })).toBe(false);
  expect(isMcpReadOperation()).toBe(false);
});
