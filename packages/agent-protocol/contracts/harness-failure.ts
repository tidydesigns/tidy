import { z } from "zod";

export const harnessFailureKindSchema = z.enum([
  "policy",
  "billing",
  "session",
  "context",
  "rate-limit",
  "authentication",
  "model",
  "permission",
  "timeout",
  "connection",
  "unavailable",
  "harness",
  "unknown",
  "budget",
  "turn-limit",
  "output",
  "output-format",
  "attachment",
  "request",
  "request-size",
  "sandbox",
  "account",
  "configuration",
  "storage",
  "workspace",
  "busy",
  "interrupted",
]);

export type HarnessFailureKind = z.infer<typeof harnessFailureKindSchema>;
