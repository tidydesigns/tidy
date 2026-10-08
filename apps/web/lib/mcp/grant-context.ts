import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type McpGrant = {
  claims: Record<string, unknown>;
  resource: string;
  scopes: readonly string[];
};

// Only the HTTP boundary supplies these already signature-verified claims.
// Tool arguments and internal agent calls never establish an external grant.
const storage = new AsyncLocalStorage<McpGrant>();
export const currentMcpGrant = () => storage.getStore();
export function withMcpGrantContext<T>(grant: McpGrant, work: () => Promise<T>) {
  return storage.run(grant, work);
}
