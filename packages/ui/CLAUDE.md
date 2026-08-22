# packages/ui/CLAUDE.md

## Purpose

Shared React component library for all Civitics products. Used by
`apps/civitics` today; future social app / mobile / embed surfaces.

## The One Rule

A component belongs in packages/ui if and only if it passes ALL of:

- Pure React — no framework deps
- No Supabase imports ever
- No Next.js imports ever
- No business logic or DB queries
- Props-driven — data passed in, never fetched internally

If it fails any check: keep it in `apps/civitics/app/components/` instead.

## Design System — "Public Record × Terminal" semantic tokens

The old blue-600/gray palette is gone. Everything renders through the
semantic token set (FIX-552), defined as CSS custom properties in
`apps/civitics/app/globals.css` and mapped to Tailwind utilities in
`apps/civitics/tailwind.config.js`.

**Mechanics (FIX-563):** each `--c-*` var holds a space-separated RGB
channel triplet (`157 43 43`, not hex). Tailwind maps them as
`rgb(var(--c-x) / <alpha-value>)`, so alpha modifiers work on every token:
`bg-ink/5`, `border-rule/60`, `bg-accent/15`.

**Tokens (paper-mode meaning):**

```
bg:      paper (page)   paper-2 (inset)   card (surface)
text:    ink (primary)  ink-soft (secondary)
lines:   rule
hues:    accent (brand red — active/selected/error)
         civic-blue     green-ink (verified/positive)
         amber (live/warning — see contrast rule)
viz:     viz-1..viz-7 — categorical chart ramp (FIX-567)
```

**Terminal scope re-bind:** wrapping a subtree in `data-theme="terminal"`
re-binds every semantic token to its dark value, so the SAME utilities
(`bg-card`, `text-ink`, `border-rule`) render dark inside live-instrument
panels. Print mode re-binds the same tokens to grayscale (FIX-713). The
scope wrapper must restate `text-ink` alongside `bg-paper` — the inherited
body color does not re-resolve inside the scope.

**The shared-component rule: semantic tokens ONLY — never `term-*` in
packages/ui.** `term-bg`/`term-txt`/`term-line`/etc. are raw dark values
that do NOT re-bind; a shared component styled with them breaks on paper
pages. Terminal-only app code may use them; shared components may not.

**Status map (Wave 1, FIX-719 — see StatusBadge):**

```
ok / complete / positive   text-green-ink  bg-green-ink/10
warning / interrupted      text-ink        bg-amber/20
error / failed             text-accent     bg-accent/10
pending / neutral          text-ink-soft   bg-rule/40
```

**Amber contrast rule:** amber TEXT is unreadable on paper. Shared and
paper-visible components use `bg-amber/20 text-ink` tints. Bare
`text-amber` is allowed only in code that renders exclusively inside a
terminal scope.

**Party colors are categorical, not status.** The semantic set has no
purple — viz-7 (wine) stands in for independents (FIX-719). The `Badge`
component variants are the reference implementation:

```
democrat      border-civic-blue/60  text-civic-blue  bg-civic-blue/10
republican    border-accent/60      text-accent      bg-accent/10
independent   border-viz-7/60       text-viz-7       bg-viz-7/10
```

`colors.ts` `PARTY_COLORS` still carries the legacy blue-600/purple-600
classes — it is consumed by graph-adjacent surfaces and folds into the
token system in the graph terminal wave. Don't model new code on it.

**SVG constraint:** `var()` fails in SVG presentation attributes
(`fill="var(--c-x)"` silently breaks). Pass `rgb(var(--c-x))` via
`style=` instead — Sparkline is the in-package example.

**Never hardcode hex, and never use raw Tailwind palette colors
(`gray-200`, `blue-600`, `indigo-*`) — tokens only.**

## Component Inventory

```
data/        StatCard  PipelineRow  Sparkline  DataQualityBar
             ActivityItem  ConnectionHighlight  CommentPeriodCard
layout/      SectionCard  SectionHeader  PageHeader  StatsRow
feedback/    StatusBadge  AlertBanner  LoadingSkeleton  EmptyState
navigation/  Breadcrumb  TabBar
root:        Badge  Button
```

Consistency rules: every page header is `PageHeader`; every section card
is `SectionCard`; every async section shows `LoadingSkeleton`; every empty
list uses `EmptyState`; every status pill is `StatusBadge` (never raw
colored dots). TabBar's active convention is `border-accent text-accent` —
mirror it for any tab-like control in app code.

## Utilities (`utils.ts`)

Always use these — never inline format logic: `formatUSD(cents)`,
`formatNumber(n)`, `formatRelativeTime(iso)`, `formatPipelineStatus(status)`.

## Hydration

Never nest `<a>` (or `<button>`/`<input>`) inside `<a>`. Card with an href
that contains its own clickable elements: outer `<div>` + stretched-link
pattern — the overlay anchor goes ABOVE the card body, and only the real
controls are raised above the overlay (FIX-1086; `CommentPeriodCard` is the
reference). Putting the content on a higher z-index than the overlay makes
the card body dead. See `apps/civitics/CLAUDE.md` → Hydration Safety.

## What NOT To Do

- Never import from Supabase or Next.js
- Never fetch data inside a component — always props
- Never hardcode colors as hex, and never raw palette classes — tokens only
- Never use `term-*` tokens in shared components
- Never build one-off card/header styles — SectionCard / PageHeader
- Never duplicate a component that already exists — check `index.ts` first

## Usage

```ts
import { StatCard, SectionCard, StatusBadge, Badge, formatUSD } from "@civitics/ui";
```
