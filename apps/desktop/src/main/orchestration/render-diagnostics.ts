import { z } from "zod";

export const renderDiagnosticSchema = z
  .object({
    kind: z.enum([
      "missing_font",
      "font_substitution",
      "font_load_error",
      "missing_asset",
      "asset_decode_error",
    ]),
    resource: z.string(),
    message: z.string(),
  })
  .strict();
export type RenderDiagnostic = z.infer<typeof renderDiagnosticSchema>;
