import "server-only";
import { z } from "zod";
import { ConnectorError, readLimited } from "@/lib/connectors/http";
import { linearRequestSignal, consumeLinearBytes } from "./work-budget";
import { waitForSignal } from "@/lib/request-lifecycle";
import { linearConfig } from "./config";

export class LinearError extends ConnectorError {
  constructor(status: number) {
    super(
      status === 401
        ? "Reconnect Linear in Settings → Connectors."
        : status === 403
          ? "Linear access denied."
          : status === 429
            ? "Linear is busy. Try again shortly."
            : "Linear is unavailable. Try again.",
      [401, 403, 404, 429].includes(status) ? status : 502,
    );
  }
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.union([z.string(), z.array(z.string())]),
});
export type LinearToken = z.infer<typeof tokenSchema>;
export function parseLinearToken(value: unknown): LinearToken {
  const token = tokenSchema.safeParse(value);
  if (!token.success) throw new LinearError(401);
  return token.data;
}
export function tokenScopes(token: LinearToken) {
  return Array.isArray(token.scope) ? token.scope : token.scope.split(/[ ,]+/).filter(Boolean);
}
export async function exchangeToken(parameters: Record<string, string>) {
  const config = linearConfig();
  const signal = linearRequestSignal();
  const response = await waitForSignal(
    fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...parameters,
      }),
    }),
    signal,
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new LinearError(response.status === 400 ? 401 : response.status);
  }
  const token = tokenSchema.safeParse(
    JSON.parse(await readLimited(response, 16000, signal, consumeLinearBytes)),
  );
  if (!token.success || !tokenScopes(token.data).includes("read")) throw new LinearError(401);
  return token.data;
}
export async function linearRequest(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const signal = linearRequestSignal();
  const response = await waitForSignal(
    fetch("https://api.linear.app/graphql", {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }),
    signal,
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new LinearError(response.status);
  }
  const text = await readLimited(response, 1024 * 1024, signal, consumeLinearBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LinearError(502);
  }
  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z
        .array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() }))
        .optional(),
    })
    .safeParse(raw);
  if (!envelope.success) throw new LinearError(502);
  const body = envelope.data;
  if (body.errors?.length || !body.data) {
    const codes = body.errors?.map((error) => error.extensions?.code);
    throw new LinearError(
      codes?.includes("RATELIMITED")
        ? 429
        : codes?.includes("AUTHENTICATION_ERROR")
          ? 401
          : codes?.includes("FORBIDDEN")
            ? 403
            : 502,
    );
  }
  return body.data;
}
export function parseLinearResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LinearError(502);
  return parsed.data;
}
export async function linearIdentity(token: string) {
  const schema = z.object({
    viewer: z.object({ id: z.string().uuid(), name: z.string() }),
    organization: z.object({ id: z.string().uuid(), name: z.string() }),
  });
  return schema.parse(
    await linearRequest(
      token,
      "query TidyIdentity { viewer { id name } organization { id name } }",
    ),
  );
}
export async function revokeToken(token: string) {
  const signal = linearRequestSignal();
  const response = await waitForSignal(
    fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "refresh_token" }),
    }),
    signal,
  );
  void response.body?.cancel().catch(() => {});
  if (![200, 400, 401].includes(response.status)) throw new LinearError(response.status);
}
