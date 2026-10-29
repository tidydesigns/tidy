import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ["dist/**", ".expo/**", "ios/**", "android/**"],
});
