import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "docs/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Shopify responses are untyped JSON; `any` is confined to where they are picked apart.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // The ones that catch real bugs in async code.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      eqeqeq: ["error", "always"],
      "no-control-regex": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly", Buffer: "readonly" } },
  },
);
