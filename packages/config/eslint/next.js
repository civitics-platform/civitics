/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [
    "./base.js",
    "next/core-web-vitals",
    "next/typescript",
  ],
  // The `next/*` configs apply after base.js and set some of the same rules
  // with their own options (next/typescript's no-unused-vars has no
  // argsIgnorePattern, for one). This block applies last, so it re-asserts
  // base.js's levels and options for the apps. FIX-460: all at error.
  rules: {
    "@next/next/no-html-link-for-pages": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    "@typescript-eslint/no-explicit-any": "error",
    "react/no-unescaped-entities": "error",
    "react/no-children-prop": "error",
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-inner-declarations": "error",
    "no-constant-condition": ["error", { checkLoops: false }],
  },
};
