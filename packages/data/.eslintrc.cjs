// FIX-1241: packages/data was never linted before FIX-460. Its backlog at
// landing was 2,445 warnings over src/ (no-console 2,388, no-explicit-any 26,
// no-unused-vars 18 — cc-168 read 2), past what one session ratchets. So these
// three rules stay at WARN for this package only, and its lint script has no
// --max-warnings 0 yet. Every other package fails on a single warning; FIX-1241
// removes this block and adds the flag.
module.exports = {
  root: true,
  extends: [require.resolve("@civitics/config/eslint/base")],
  rules: {
    "no-console": ["warn", { allow: ["info", "warn", "error"] }],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
  },
};
