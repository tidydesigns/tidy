import { bindingKinds, type TokenBinding } from "./token-bindings";
export { bindingKinds, type TokenBinding } from "./token-bindings";
import { z } from "zod";

export const tokenNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const finite = z.number().finite();
export const typographyTokenValueSchema = z
  .object({
    fontFamily: z.string().max(100).optional(),
    fontSource: z.enum(["web", "local", "system"]).optional(),
    fontFace: z.string().max(200).optional(),
    fontSize: finite.min(6).max(300).optional(),
    fontWeight: finite.int().min(1).max(1000).optional(),
    fontStyle: z.enum(["normal", "italic"]).optional(),
    lineHeight: finite.min(0.0001).max(200).optional(),
    lineHeightMode: z.enum(["auto", "percent", "px"]).optional(),
    lineHeightPx: finite.min(0.1).max(1200).optional(),
    letterSpacing: finite.min(-100).max(100).optional(),
    paragraphSpacing: finite.min(0).max(1000).optional(),
    textCase: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    textDecoration: z.enum(["none", "underline", "line-through"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "A text style needs at least one property.");
export const tokenTypeSchema = z.enum([
  "color",
  "radius",
  "spacing",
  "dimension",
  "number",
  "typography",
]);
export const designTokenSchema = z.union([
  z
    .object({
      type: z.literal("color"),
      value: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
    })
    .strict(),
  z.object({ type: z.literal("radius"), value: finite.min(0).max(5000) }).strict(),
  z.object({ type: z.literal("spacing"), value: finite.min(-1000).max(1000) }).strict(),
  z.object({ type: z.literal("dimension"), value: finite.min(0).max(5000) }).strict(),
  z.object({ type: z.literal("number"), value: finite.min(-100000).max(100000) }).strict(),
  z.object({ type: z.literal("typography"), value: typographyTokenValueSchema }).strict(),
  z.object({ type: tokenTypeSchema, alias: tokenNameSchema }).strict(),
]);
export const designTokensSchema = z
  .record(tokenNameSchema, designTokenSchema)
  .refine((tokens) => Object.keys(tokens).length <= 1000, "At most 1,000 design tokens.");
export const tokenBindingsSchema = z
  .object(
    Object.fromEntries(
      Object.keys(bindingKinds).map((key) => [key, tokenNameSchema.nullable().optional()]),
    ) as Record<TokenBinding, z.ZodOptional<z.ZodNullable<typeof tokenNameSchema>>>,
  )
  .strict();
export type DesignToken = z.infer<typeof designTokenSchema>;
export type DesignTokens = z.infer<typeof designTokensSchema>;
