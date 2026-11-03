import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config (ESLint 9). Type-aware rules are intentionally left off so lint
// stays fast and needs no tsconfig project wiring; `tsc --noEmit` (the per-package
// typecheck script) covers type correctness.
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/target/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Disable formatting-related rules that would conflict with Prettier.
  prettier,
);
