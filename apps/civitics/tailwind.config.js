/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx,js,jsx}",
    "../../packages/ui/src/**/*.{ts,tsx,js,jsx}",
    // FIX-728: the graph package is token-native — its classes must be scanned.
    // Previously graph-only Tailwind classes compiled only when they happened
    // to coincide with app/ui usage.
    "../../packages/graph/src/**/*.{ts,tsx,js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Legacy indigo palette — unmigrated pages still reference civic-*.
        civic: {
          50: "#f0f4ff",
          100: "#e0e9ff",
          200: "#c7d5fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
        // "Public Record × Terminal" semantic tokens (FIX-552). Values live as
        // CSS custom properties in globals.css; a [data-theme="terminal"]
        // wrapper re-binds the paper-mode vars, so the same utilities render
        // dark inside terminal-scoped panels. Vars hold RGB channel triplets
        // (FIX-563) so <alpha-value> works: bg-ink/5, border-rule/60, etc.
        paper:      "rgb(var(--c-paper) / <alpha-value>)",
        "paper-2":  "rgb(var(--c-paper-2) / <alpha-value>)",
        card:       "rgb(var(--c-card) / <alpha-value>)",
        ink:        "rgb(var(--c-ink) / <alpha-value>)",
        "ink-soft": "rgb(var(--c-ink-soft) / <alpha-value>)",
        rule:       "rgb(var(--c-rule) / <alpha-value>)",
        accent:     "rgb(var(--c-accent) / <alpha-value>)",
        "civic-blue": "rgb(var(--c-blue) / <alpha-value>)",
        "green-ink":  "rgb(var(--c-green-ink) / <alpha-value>)",
        "term-bg":    "rgb(var(--c-term-bg) / <alpha-value>)",
        "term-panel": "rgb(var(--c-term-panel) / <alpha-value>)",
        "term-line":  "rgb(var(--c-term-line) / <alpha-value>)",
        "term-txt":   "rgb(var(--c-term-txt) / <alpha-value>)",
        "term-dim":   "rgb(var(--c-term-dim) / <alpha-value>)",
        "term-faint": "rgb(var(--c-term-faint) / <alpha-value>)",
        amber:        "rgb(var(--c-amber) / <alpha-value>)",
        "term-green": "rgb(var(--c-term-green) / <alpha-value>)",
        "term-red":   "rgb(var(--c-term-red) / <alpha-value>)",
        "term-blue":  "rgb(var(--c-term-blue) / <alpha-value>)",
        // Categorical data-viz ramp (FIX-567) — 7 mutually-distinguishable
        // hues for chart/bar fills; terminal-scope re-binds to luminous variants.
        "viz-1": "rgb(var(--c-viz-1) / <alpha-value>)",
        "viz-2": "rgb(var(--c-viz-2) / <alpha-value>)",
        "viz-3": "rgb(var(--c-viz-3) / <alpha-value>)",
        "viz-4": "rgb(var(--c-viz-4) / <alpha-value>)",
        "viz-5": "rgb(var(--c-viz-5) / <alpha-value>)",
        "viz-6": "rgb(var(--c-viz-6) / <alpha-value>)",
        "viz-7": "rgb(var(--c-viz-7) / <alpha-value>)",
        "viz-8": "rgb(var(--c-viz-8) / <alpha-value>)",
        "viz-9": "rgb(var(--c-viz-9) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
