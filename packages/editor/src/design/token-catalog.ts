import { parseDesignDocument, type DesignDocument } from "./document";
import { type DesignToken, type DesignTokens, tokenNameSchema } from "./design-tokens";
export const tokenDefaults = {
  color: { type: "color", value: "#ff5d00" },
  radius: { type: "radius", value: 8 },
  spacing: { type: "spacing", value: 8 },
  dimension: { type: "dimension", value: 100 },
  number: { type: "number", value: 1 },
  typography: {
    type: "typography",
    value: {
      fontFamily: "system-ui",
      fontSource: "system",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.35,
      lineHeightMode: "percent",
    },
  },
} satisfies { [Type in DesignToken["type"]]: Extract<DesignToken, { type: Type }> };

export function tokenNameError(document: DesignDocument, name: string, current?: string) {
  if (!tokenNameSchema.safeParse(name).success)
    return "Use a letter first, then letters, numbers, hyphens or underscores (up to 64).";
  if (
    name !== current &&
    (Object.hasOwn(document.tokens, name) || Object.hasOwn(document.designTokens ?? {}, name))
  )
    return "A token with that name already exists.";
}

export function availableTokenName(document: DesignDocument, base: string) {
  let name = base,
    index = 2;
  while (Object.hasOwn(document.tokens, name) || Object.hasOwn(document.designTokens ?? {}, name))
    name = `${base.slice(0, 58)}-${index++}`;
  return name;
}

/** Replace either wire format without changing references to the token's name. */
export function putDesignToken(document: DesignDocument, name: string, token: DesignToken) {
  const tokens = { ...document.tokens };
  delete tokens[name];
  return parseDesignDocument({
    ...document,
    tokens,
    designTokens: { ...document.designTokens, [name]: token },
  });
}

/** Merge named definitions; unrelated tokens and all existing references stay intact. */
export function mergeDesignTokens(document: DesignDocument, definitions: DesignTokens) {
  const tokens = { ...document.tokens };
  for (const name of Object.keys(definitions)) delete tokens[name];
  return parseDesignDocument({
    ...document,
    tokens,
    designTokens: { ...document.designTokens, ...definitions },
  });
}
