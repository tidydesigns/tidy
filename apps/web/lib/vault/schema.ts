import type { BetterAuthPlugin } from "better-auth";

export const vaultSchema = {
  id: "bella-vault",
  schema: {
    vaultLogin: {
      fields: {
        userId: {
          type: "string",
          required: true,
          references: { model: "user", field: "id", onDelete: "cascade" },
          index: true,
        },
        name: { type: "string", required: true },
        ciphertext: { type: "string", required: true, returned: false },
        iv: { type: "string", required: true, returned: false },
        authTag: { type: "string", required: true, returned: false },
        keyVersion: { type: "number", required: true, returned: false },
        createdAt: { type: "date", required: true },
      },
    },
  },
} satisfies BetterAuthPlugin;
