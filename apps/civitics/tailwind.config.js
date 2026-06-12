/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{ts,tsx,js,jsx}",
    "../../packages/ui/src/**/*.{ts,tsx,js,jsx}",
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
        // dark inside terminal-scoped panels.
        paper:      "var(--c-paper)",
        "paper-2":  "var(--c-paper-2)",
        card:       "var(--c-card)",
        ink:        "var(--c-ink)",
        "ink-soft": "var(--c-ink-soft)",
        rule:       "var(--c-rule)",
        accent:     "var(--c-accent)",
        "civic-blue": "var(--c-blue)",
        "term-bg":    "var(--c-term-bg)",
        "term-panel": "var(--c-term-panel)",
        "term-line":  "var(--c-term-line)",
        "term-txt":   "var(--c-term-txt)",
        "term-dim":   "var(--c-term-dim)",
        "term-faint": "var(--c-term-faint)",
        amber:        "var(--c-amber)",
        "term-green": "var(--c-term-green)",
        "term-red":   "var(--c-term-red)",
        "term-blue":  "var(--c-term-blue)",
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
