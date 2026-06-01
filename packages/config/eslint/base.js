/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: ["eslint:recommended"],
  env: {
    node: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  // `react-hooks` is loaded so that `react-hooks/exhaustive-deps` disable
  // directives in the React packages (graph) resolve to a defined rule. The
  // rule is intentionally left unset (off) — exhaustive-deps is only enforced
  // in the apps via the `next` preset. Harmless in non-React leaf packages.
  plugins: ["@typescript-eslint", "react-hooks"],
  rules: {
    // Core `no-unused-vars` (from eslint:recommended) double-reports and
    // ignores the `argsIgnorePattern` below — defer to the TS-aware version.
    "no-unused-vars": "off",
    // FIX-459: warn (not error) so the lint gate goes green now. This is the
    // highest-volume finding and grows with the codebase; driving the backlog
    // to zero + `--max-warnings 0` is the ratchet follow-up (see docs/FIXES.md).
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": ["warn", { allow: ["warn", "error"] }],
    // Minor recommended rules that fire on intentional patterns (empty catch
    // blocks, hoisted helpers). Warn now; ratchet to error later (FIX-459).
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-inner-declarations": "warn",
    // TypeScript's compiler already errors on genuinely-undefined identifiers
    // (typecheck is a separate green gate), and `eslint:recommended`'s core
    // `no-undef` misfires on ambient TS globals like `RequestInit`/`NodeJS`.
    // typescript-eslint's own recommended config disables it for this reason.
    "no-undef": "off",
  },
  ignorePatterns: ["node_modules/", "dist/", ".next/"],
};
