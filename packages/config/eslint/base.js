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
    // FIX-460: every rule FIX-459 downgraded to warn is back at error, and
    // every lint script runs with --max-warnings 0, so a warning inherited
    // from an upstream config fails the gate too. An exception is a
    // `// eslint-disable-next-line <rule> -- <reason>` at the line, never a
    // rule turned down here.
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    "@typescript-eslint/no-explicit-any": "error",
    // The allow-list is the policy. console.log is debug debris and is banned;
    // console.info is DELIBERATE operator output (a cron receipt, a CLI's
    // report) — the same stdout stream as .log, so moving a real line to .info
    // changes nothing at runtime; warn/error are diagnostics. table and dir
    // are operator output by construction (FIX-1241: 60 calls across 12
    // investigation scripts, plus 4 pipeline reporters that had each carried
    // a disable for one). Neither has an .info form that prints the same.
    "no-console": ["error", { allow: ["info", "warn", "error", "table", "dir"] }],
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-inner-declarations": "error",
    // `while (true) { … break; }` is the paging-loop idiom across the
    // pipelines (nine sites in packages/data). ESLint 9 made loops exempt by
    // default for exactly this; on 8 the option is checkLoops. Constant
    // conditions in if/ternary/&& are still errors.
    "no-constant-condition": ["error", { checkLoops: false }],
    // TypeScript's compiler already errors on genuinely-undefined identifiers
    // (typecheck is a separate green gate), and `eslint:recommended`'s core
    // `no-undef` misfires on ambient TS globals like `RequestInit`/`NodeJS`.
    // typescript-eslint's own recommended config disables it for this reason.
    "no-undef": "off",
  },
  ignorePatterns: ["node_modules/", "dist/", ".next/"],
};
