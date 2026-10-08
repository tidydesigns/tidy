import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { planLimitMessage } from "./plans";

// A preflight can pass just before another request consumes the last seat.
// Translate the authoritative database rejection into Better Auth's public
// error format, including for writes made by its organization adapter.
export const planErrorsPlugin = {
  id: "plan-errors",
  init(context) {
    const adapter = context.adapter;
    // Keep adapter identity: Better Auth associates schema checks with it.
    for (const property of ["create", "update", "updateMany"] as const) {
      const operation = adapter[property];
      Object.defineProperty(adapter, property, {
        ...Object.getOwnPropertyDescriptor(adapter, property),
        value: async (...args: unknown[]) => {
          try {
            return await Reflect.apply(operation, adapter, args);
          } catch (error) {
            const message = planLimitMessage(error);
            if (message) throw new APIError("FORBIDDEN", { code: "PLAN_LIMIT", message });
            throw error;
          }
        },
      });
    }
  },
} satisfies BetterAuthPlugin;
