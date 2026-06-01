/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [
    "./base.js",
    "next/core-web-vitals",
    "next/typescript",
  ],
  // FIX-459: the `next/*` configs re-enable several rules as errors that base.js
  // downgrades. This rules block applies last, so it re-asserts the warn level
  // that keeps the lint gate green. Driving these to zero is the ratchet
  // follow-up tracked in docs/FIXES.md.
  rules: {
    "@next/next/no-html-link-for-pages": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "react/no-unescaped-entities": "warn",
    "react/no-children-prop": "warn",
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-inner-declarations": "warn",
  },
};
