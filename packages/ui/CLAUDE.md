# packages/ui/CLAUDE.md

## Purpose

Shared React component library
for all Civitics products.

These components are used by:
  apps/civitics (main web app)
  Future: social app
  Future: mobile app
  Future: embed pages

## The One Rule

A component belongs in packages/ui
if and only if it passes ALL of:

  ✓ Pure React — no framework deps
  ✓ No Supabase imports ever
  ✓ No Next.js imports ever
  ✓ No business logic or DB queries
  ✓ Props-driven — data passed in,
    never fetched internally
  ✓ Could run in a React Native
    app with minimal changes

If it fails any check:
  Keep it in apps/civitics/
  components/ instead

## Design System

Civitics visual language:
  Font: system-ui / Inter
  Radius: rounded-lg (8px) default
           rounded-xl (12px) for cards
           rounded-full for badges/pills
  Shadow: shadow-sm for cards
          shadow-lg for popups/modals
  Border: border border-gray-200

  Spacing: 4px base unit (Tailwind)

  Motion: transition-all duration-150
    for hover states
    duration-200 for panel opens
    No motion if prefers-reduced-motion

Colors (never hardcode hex —
always use Tailwind classes):

  Brand:
    Primary:   blue-600 (#2563eb)
    Secondary: gray-900
    Accent:    amber-500

  Party:
    Democrat:   blue-600
    Republican: red-600
    Independent: purple-600
    Other:      amber-600

  Status:
    Success:  green-500
    Warning:  amber-500
    Error:    red-500
    Info:     blue-500
    Neutral:  gray-400

  Pipeline status colors:
    complete:     green-500 ✓
    running:      blue-500 ⟳
    interrupted:  amber-500 ⚠
    failed:       red-500 ✗
    pending:      gray-400 ○

Typography scale:
  Page title:    text-2xl font-bold
  Section title: text-lg font-semibold
  Card title:    text-base font-semibold
  Body:          text-sm text-gray-700
  Caption:       text-xs text-gray-500
  Stat number:   text-3xl font-bold
                 tabular-nums

## Component Inventory

### Data Display

StatCard
  The primary metric card used
  across all dashboard views.
  Shows a single number with
  label, trend, and optional
  action link.

PipelineRow
  One row in a pipeline status
  list. Shows name, status badge,
  timestamp, row count, delta flag.

Sparkline
  Tiny inline SVG chart for
  7-day or 30-day trends.
  No axes, no labels — just
  the shape of the data.

DataQualityBar
  Horizontal progress bar showing
  coverage percentage with label.
  e.g. "FEC coverage: 86.1%"

ActivityItem
  One item in an activity feed.
  Icon, description, timestamp,
  optional link.

ConnectionHighlight
  A single "A → B: $X" flow
  with party colors and graph link.

CommentPeriodCard
  A regulation with open comment
  period. Title, agency, deadline
  countdown, submit button.

### Layout

SectionCard
  Consistent card wrapper used
  by every dashboard section.
  White bg, border, rounded-xl,
  shadow-sm, padding.
  Has header slot and body slot.

SectionHeader
  Title + optional description
  + optional action button.
  Used inside SectionCard header.

PageHeader
  Top of every page.
  Title, breadcrumb, optional CTA.
  Consistent across all pages.

### Feedback

StatusBadge
  Pill badge for pipeline status,
  data freshness, system health.
  Colors from design system above.

AlertBanner
  Full-width banner for warnings,
  errors, or info messages.
  Dismissible. Levels: info,
  warning, error, success.

LoadingSkeleton
  Animated gray placeholder
  matching the shape of the
  content it replaces.
  Used during data fetching.

EmptyState
  Centered illustration + message
  for empty lists/sections.
  Optional action button.

### Navigation

Breadcrumb
  Simple path navigation.
  Used on all interior pages.

TabBar
  Horizontal tab navigation.
  Used on official/proposal
  detail pages.

## Consistency Rules

HEADERS — every page uses PageHeader:
  Never build a one-off header
  Always use PageHeader component
  Breadcrumb always present on
  interior pages

CARDS — every section uses SectionCard:
  Never style a raw <div> as a card
  Always use SectionCard
  Consistent padding, border,
  shadow across all pages

LOADING — every async section:
  Always show LoadingSkeleton
  while data is fetching
  Never show blank/empty space
  Never show raw "Loading..."
  text — use the skeleton

EMPTY — every list:
  Always use EmptyState component
  Never show blank lists
  Always explain why it's empty
  Always offer an action

STATUS — every pipeline/data item:
  Always use StatusBadge
  Never use raw colored dots
  or custom status text

## File Structure

packages/ui/src/
  index.ts              ← exports everything

  components/
    data/
      StatCard.tsx
      PipelineRow.tsx
      Sparkline.tsx
      DataQualityBar.tsx
      ActivityItem.tsx
      ConnectionHighlight.tsx
      CommentPeriodCard.tsx

    layout/
      SectionCard.tsx
      SectionHeader.tsx
      PageHeader.tsx

    feedback/
      StatusBadge.tsx
      AlertBanner.tsx
      LoadingSkeleton.tsx
      EmptyState.tsx

    navigation/
      Breadcrumb.tsx
      TabBar.tsx

  types.ts              ← shared prop types
  colors.ts             ← color constants
  utils.ts              ← formatters:
                          formatUSD()
                          formatNumber()
                          formatRelativeTime()
                          formatPipelineStatus()

## Utility Functions

Always use these — never
inline format logic in components:

formatUSD(cents: number): string
  -- 1234567 → "$12,345"
  -- Always cents input
  -- Never raw dollars

formatNumber(n: number): string
  -- 8251 → "8,251"
  -- 143077 → "143,077"
  -- 1750385520 → "$1.75B" (if USD)

formatRelativeTime(iso: string): string
  -- "2026-03-22T02:00:00Z"
  -- → "2 hours ago"
  -- → "just now"
  -- → "3 days ago"

formatPipelineStatus(
  status: string
): { label: string, color: string,
     icon: string }
  -- 'complete' → { label: 'Complete',
  --   color: 'green', icon: '✓' }
  -- 'running'  → { label: 'Running',
  --   color: 'blue', icon: '⟳' }
  -- 'interrupted' → { label: 'Interrupted',
  --   color: 'amber', icon: '⚠' }
  -- 'failed'   → { label: 'Failed',
  --   color: 'red', icon: '✗' }

## Hydration

✗ Never nest <a> inside <a>

  If a card has href AND contains
  a clickable badge/button with
  its own href:
    Card outer: <a> or <div onClick>
    Inner link: <span role="link">
      with onClick + stopPropagation

  This applies to:
    StatCard
    ActivityItem  
    CommentPeriodCard
    PipelineRow
    Any future card component

## What NOT To Do

✗ Never import from Supabase
✗ Never import from Next.js
✗ Never fetch data inside
  a component — always props
✗ Never hardcode colors as hex
  — always Tailwind classes
✗ Never build one-off card
  styles — always SectionCard
✗ Never build one-off headers
  — always PageHeader
✗ Never show blank loading states
  — always LoadingSkeleton
✗ Never use inline styles
  except for dynamic values
  (chart dimensions, positions)
✗ Never duplicate a component
  that already exists here
  — check index.ts first

## Usage

  import {
    StatCard,
    SectionCard,
    PipelineRow,
    StatusBadge,
    formatRelativeTime,
    formatUSD
  } from '@civitics/ui'
