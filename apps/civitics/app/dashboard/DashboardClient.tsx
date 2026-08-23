"use client";

import { useState, useEffect } from "react";
import {
  Users, ScrollText, Vote, DollarSign,
  RefreshCw, Lightbulb, Eye, Rocket, CircleCheck, CircleX,
  Megaphone,
} from "lucide-react";
import { Icon } from "@civitics/graph";
import {
  StatCard,
  StatsRow,
  SectionCard,
  SectionHeader,
  EmptyState,
  CommentPeriodCard,
  DataQualityBar,
  ConnectionHighlight,
  AlertBanner,
  StatusBadge,
  formatRelativeTime,
  formatNumber,
} from "@civitics/ui";
import {
  useDashboardData,
  isPartial,
  type AiCosts,
  type PipelineHistoryRun,
  type ActivitySectionData,
  type OfficialsBreakdown,
  type DatabaseStats,
  type StatusData,
  type PipelineRuntimeStat,
} from "./useDashboardData";
import { useIsAdmin } from "@/lib/use-is-admin";
// FIX-1082/1083 — duration + 30-day-stat formatting shared with
// /admin/pipeline-health. Import-safe from a client component: the module has
// no server-only dependencies at module scope.
import { formatDurationMs, runDurationMs } from "@/lib/pipeline-runtime-stats";
// FIX-1097 — type only; the parse itself runs server-side in /api/shipped.
import type { ShippedEntry } from "@/lib/done-log";
// FIX-1094 — snapshot-age cue. Import-safe from a client component by
// construction: snapshot-freshness.ts has no imports at all (that is why the
// constant was moved out of _lib/status-snapshot.ts, which pulls in @civitics/db).
import { classifySnapshotAge } from "@/lib/snapshot-freshness";
import dynamic from "next/dynamic";

const AnthropicCard = dynamic(
  () => import("./components/AnthropicCard").then((m) => ({ default: m.AnthropicCard })),
  { ssr: false },
);

const PlatformCostsSection = dynamic(
  () => import("./PlatformCostsSection").then((m) => ({ default: m.PlatformCostsSection })),
  { ssr: false },
);

// ── Types ─────────────────────────────────────────────────────────────────────

type OpenProposal = {
  id: string;
  title: string;
  agency: string;
  comment_period_end: string;
};

type ActivityRow = { path: string; views: number };

interface DashboardClientProps {
  openProposals: OpenProposal[];
  openProposalCount: number;
  tab: "transparency" | "operations";
  initialStatus: StatusData | null;
}

// ── Pipeline display name mapping ────────────────────────────────────────────

// `cadence` drives per-pipeline freshness thresholds (see freshnessFor()
// below). Without it, every pipeline was scored against a single 48h ok /
// 168h warning threshold, which flagged TIGER (annual) as red after 7 days,
// hid actually-stale daily pipelines, and disagreed with /admin/pipeline-
// health. Values picked from .github/workflows/*.yml + a prod audit query
// against data_sync_log (see scripts/pipeline-cadence-audit.ts).
type Cadence =
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "on_demand"   // no expected schedule; healthy as long as any run exists
  | "continuous"; // background queue; freshness reads activity, not last_run

const SLOW_CADENCES: ReadonlySet<Cadence> = new Set([
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "on_demand",
]);

// One row on the Data Health card. `aliases` holds every writer-side name that
// should be merged into this row's history — used when one display row covers
// multiple sub-pipelines (e.g. Congress = officials + votes + committees).
// The list of writers is the audit ground truth from `grep startSync`.
//
// FIX-1083 — every `aliases` / `retiredAliases` entry is a PERSISTED STORE KEY:
// it is the literal `data_sync_log.pipeline` string a writer has been writing
// for months, and a row's whole history is addressed by it. Registration here
// is DISPLAY-LAYER ONLY. Never "tidy up" a name on this side and never rename
// one at the writer to match — renaming a store key orphans everything written
// under the old one.
type PipelineDef = {
  key: string; // canonical key (used as React key + display name fallback)
  display: string; // user-facing label
  aliases: string[]; // writer-side `pipeline` strings that map to this row
  // FIX-1082 — writer-side names this row USED to be fed by. Their history is
  // still merged in and still shown (nothing is hidden), but they are excluded
  // from computeRowVerdict.
  //
  // The bug: computeRowVerdict ranked every alias including ones with zero rows
  // ever, and an alias with no `latest` ranks as the row's worst, so the whole
  // row read "Pending" forever and the expanded sub-pipeline table printed
  // "(no runs in window)" with an amber "← propagating" arrow pointing at a
  // writer that does not exist. Congress.gov, FEC / Donors and Regulations.gov
  // were all parked this way — every one of them ingesting fine daily.
  retiredAliases?: string[];
  cadence: Cadence; // expected schedule, drives freshness thresholds
  dbTotals?: (db: DatabaseStats) => Array<{ value: number; label: string }>;
  source?: { label: string; href: string };
  retryCmd?: string;
  note?: string; // optional caveat shown in the expansion (e.g. "no log writer yet")
  // FIX-1083 (maintenance rows only) — plain-language "what this does", and the
  // human cadence read off `cron.job.schedule` BY JOBNAME. Both render publicly.
  blurb?: string;
  scheduleLabel?: string;
};

// ── Data sources: external ingests ───────────────────────────────────────────
const PIPELINES: PipelineDef[] = [
  {
    key: "congress",
    display: "Congress.gov",
    aliases: ["congress_officials", "congress_votes"],
    // FIX-1082 — `congress` has ZERO rows in prod data_sync_log across the
    // whole post-cutover history (2026-04-22 →). The writers are the two split
    // aliases, both of which ran within the last 24h at census time.
    retiredAliases: ["congress"],
    cadence: "daily",
    dbTotals: (db) => [
      { value: db.officials, label: "officials" },
      { value: db.proposals_bills, label: "bills + resolutions" },
    ],
    source: { label: "Congress.gov", href: "https://congress.gov" },
    retryCmd: "pnpm data:officials  /  data:votes",
  },
  {
    // Split out of the Congress.gov row (was an alias under cadence: "daily")
    // because committees run weekly via the Sunday-only orchestrator block
    // — bundling them under daily made the row read false-red every weekday.
    key: "congress_committees",
    display: "Congress Committees",
    aliases: ["congress_committees"],
    cadence: "weekly",
    source: { label: "Congress.gov", href: "https://congress.gov" },
    retryCmd: "pnpm data:committees",
  },
  {
    key: "regulations",
    display: "Regulations.gov",
    aliases: ["regulations"],
    // FIX-1082 — `federal_register` has ZERO rows in prod data_sync_log ever;
    // `regulations` is the live writer (129 runs, daily). The audit predicted
    // "one of regulations / federal_register" is dead; the census named it.
    retiredAliases: ["federal_register"],
    cadence: "daily",
    dbTotals: (db) => [
      { value: db.proposals_regulations, label: "regulations" },
    ],
    source: { label: "Regulations.gov", href: "https://regulations.gov" },
    retryCmd: "pnpm data:regulations",
  },
  {
    key: "fec_bulk",
    display: "FEC / Donors",
    aliases: ["fec_bulk"],
    // FIX-1082 — `fec` has ZERO rows in prod data_sync_log ever. `fec_bulk` is
    // the writer (54 runs).
    retiredAliases: ["fec"],
    cadence: "weekly",
    dbTotals: (db) => [
      { value: db.financial_entities, label: "donors / PACs" },
      { value: db.financial_relationships, label: "donations" },
    ],
    source: { label: "FEC.gov", href: "https://www.fec.gov" },
    retryCmd: "pnpm data:fec-bulk",
  },
  {
    key: "usaspending",
    // FIX-249 deprecated the legacy `usaspending` (API path) alias — bulk is
    // the live writer. Audit shows bulk + assistance run on the Sunday block.
    display: "USAspending",
    aliases: ["usaspending_bulk", "usaspending_bulk_assistance"],
    cadence: "weekly",
    dbTotals: (db) => [
      { value: db.financial_relationships, label: "spending records (shared)" },
    ],
    source: { label: "USAspending.gov", href: "https://usaspending.gov" },
    retryCmd: "pnpm data:usaspending-bulk",
  },
  {
    key: "openstates",
    display: "OpenStates",
    // `openstates_bulk_people` runs daily; `openstates` (v3 API for term
    // dates + bills) runs weekly in the Sunday block. Weekly is the row's
    // cadence — daily satisfies, weekly stale on the API side is what
    // worst-status propagation surfaces.
    aliases: ["openstates", "openstates_bulk_people"],
    cadence: "weekly",
    source: { label: "OpenStates.org", href: "https://openstates.org" },
    retryCmd: "pnpm data:states  /  data:states-api",
  },
  {
    key: "courtlistener",
    display: "CourtListener",
    aliases: ["courtlistener"],
    // packages/data/CLAUDE.md: "weekly via nightly orchestrator (Sunday-only
    // block)". Audit confirms ~5d gap between runs.
    cadence: "weekly",
    source: { label: "CourtListener", href: "https://www.courtlistener.com" },
    retryCmd: "pnpm data:courts",
  },
  {
    key: "elections",
    display: "Elections",
    aliases: ["elections"],
    cadence: "annual",
    retryCmd: "pnpm data:elections",
  },
  {
    key: "opensecrets",
    display: "OpenSecrets",
    aliases: ["opensecrets_bulk"],
    // FIX-1082 — was `monthly`, which made "never ran" resolve to freshness
    // 'error' and painted the row red on a public page. The writer exists
    // (packages/data/src/pipelines/opensecrets-bulk, `pnpm
    // data:opensecrets-bulk`) but has logged zero runs since the 2026-04-22
    // cutover: it is manual-only, not scheduled and not broken. `on_demand` is
    // the honest cadence and renders "Loaded never".
    cadence: "on_demand",
    note: "Manual pipeline — not on the nightly orchestrator or pg_cron. No run has been recorded since the April 2026 cutover.",
    retryCmd: "pnpm data:opensecrets-bulk",
  },
  {
    key: "govtrack",
    display: "GovTrack Cosponsors",
    aliases: ["govtrack_cosponsors"],
    // FIX-1082 — same as OpenSecrets: real writer, zero runs since cutover,
    // manual only. Was `weekly` → permanent red.
    cadence: "on_demand",
    note: "Manual pipeline — not on the nightly orchestrator or pg_cron. No run has been recorded since the April 2026 cutover.",
    retryCmd: "pnpm data:govtrack-cosponsors",
  },
  {
    key: "legistar",
    display: "Legistar (local)",
    aliases: ["legistar"],
    // packages/data/CLAUDE.md: "Manual only" — not on the orchestrator.
    cadence: "on_demand",
    retryCmd: "pnpm data:legistar",
  },
  {
    key: "agencies",
    display: "Agencies (hierarchy)",
    aliases: ["agencies_hierarchy"],
    cadence: "quarterly",
    retryCmd: "pnpm data:agencies",
  },
  {
    key: "agency_leadership",
    display: "Agency Leadership",
    aliases: ["agency_leadership"],
    // packages/data/CLAUDE.md: Sunday block of nightly. Audit shows ~weekly
    // cadence in prod; the "federal directory rarely changes" assumption is
    // about content churn, not run frequency.
    cadence: "weekly",
    retryCmd: "pnpm data:agency-leadership",
  },
  {
    key: "agency_enrichment",
    display: "Agency Enrichment",
    aliases: ["agency_enrichment"],
    // First Sunday of month per packages/data/CLAUDE.md ("Monthly").
    cadence: "monthly",
    retryCmd: "pnpm data:agency-enrichment",
  },
  {
    key: "opm_fte",
    display: "OPM FTE",
    aliases: ["opm_fte"],
    cadence: "weekly",
    retryCmd: "pnpm data:opm-fte",
  },
  {
    key: "plum_book",
    display: "PLUM Book",
    aliases: ["plum_book"],
    cadence: "weekly",
    retryCmd: "pnpm data:plum-book",
  },
  {
    key: "irs990",
    display: "IRS 990 (nonprofits)",
    aliases: ["irs990"],
    // packages/data/CLAUDE.md: weekly Sunday after FEC bulk. HEAD-watermark
    // short-circuits cheaply when IRS bulk hasn't changed, but the pipeline
    // still records a run each Sunday.
    cadence: "weekly",
    source: { label: "IRS 990 Bulk", href: "https://apps.irs.gov/pub/epostcard/990/xml/" },
    retryCmd: "pnpm data:irs990",
  },
  {
    key: "littlesis",
    display: "LittleSis",
    aliases: ["littlesis"],
    cadence: "weekly",
    source: { label: "LittleSis", href: "https://littlesis.org" },
    retryCmd: "pnpm data:littlesis",
  },
  {
    key: "edgar",
    display: "SEC EDGAR (weekly)",
    aliases: ["edgar"],
    // Weekly full reconciliation of the S&P 500 universe (FIX-253).
    cadence: "weekly",
    source: { label: "SEC EDGAR", href: "https://www.sec.gov/edgar" },
    retryCmd: "pnpm data:edgar",
  },
  {
    key: "edgar_daily",
    display: "SEC EDGAR (daily)",
    aliases: ["edgar_daily"],
    // Daily SC 13D/13G scan over tracked CIKs. `status: skipped` on quiet
    // days is normal — no new filings doesn't constitute failure.
    cadence: "daily",
    source: { label: "SEC EDGAR", href: "https://www.sec.gov/edgar" },
    retryCmd: "pnpm data:edgar:daily",
  },
  {
    key: "districts",
    display: "TIGER Districts",
    aliases: ["tiger_districts"],
    // Census TIGER/Line ships annually. Manual reruns happen but don't
    // change the underlying cadence designation.
    cadence: "annual",
    retryCmd: "pnpm data:districts",
  },
];

// ── Platform maintenance: derived rollups, rebuilds and sweeps ────────────────
//
// FIX-1083 — these writers were always on the dashboard, but only as the
// orphan synthesiser's output: a public page rendering the literal strings
// "donor_rollup_refresh (orphan)" and "no DB mapping", with an expanded note
// telling the reader to go add an entry to this file. They are not mysteries —
// they are the platform's own maintenance work, and the transparency argument
// for showing them is the same one that puts the ingests on a public page. So
// they get real names, a plain-language line, and their real cadence.
//
// `scheduleLabel` is read off `cron.job.schedule` BY JOBNAME (never jobid —
// jobids are environment-specific and shift on reschedule). Census taken
// against prod 2026-08-22; the jobname each row maps to is named in a comment
// so the next person can re-run the census and diff it.
//
// Cadence tiers are the freshness thresholds, NOT the schedule: a job that
// fires Mon+Wed is tiered `weekly` because 8d/15d is the right ok/warn band
// for a twice-weekly job that can legitimately skip one firing.
const MAINTENANCE: PipelineDef[] = [
  {
    key: "entity_connections_rebuild",
    display: "Connection graph rebuild",
    aliases: ["entity_connections_rebuild"],
    // cron.job: rebuild-ec-incremental-mon `0 8 * * 1`, rebuild-ec-incremental
    // `0 8 * * 3`. Both CALL run_entity_connections_rebuild('incremental').
    cadence: "weekly",
    scheduleLabel: "Mondays + Wednesdays, 08:00 UTC",
    blurb:
      "Derives the connection edges the graph is built from — who donated to whom, who voted how, which contracts went where.",
    dbTotals: (db) => [{ value: db.entity_connections, label: "edges" }],
    // FIX-1084: a firing runs to its 5h budget, banks its progress and closes
    // 'partial', resuming from that checkpoint next time. Partial is the
    // healthy steady state here, not a warning.
    note:
      "Runs against a 5-hour budget and resumes where it left off, so a run that ends 'Partial' has banked its work and is not a failure.",
    retryCmd: "CALL run_entity_connections_rebuild('incremental');",
  },
  {
    key: "entity_connection_stats_rebuild",
    display: "Connection counts",
    aliases: ["entity_connection_stats_rebuild"],
    // cron.job: entity-connection-stats-rebuild `0 16 * * 1,3`.
    cadence: "weekly",
    scheduleLabel: "Mondays + Wednesdays, 16:00 UTC",
    blurb:
      "Pre-counts each entity's connections so profile pages and the graph can show totals without counting millions of edges on every page load.",
    retryCmd: "CALL rebuild_entity_connection_stats();",
  },
  {
    key: "donor_rollup_refresh",
    display: "Donor rollups",
    // cron.job: donor-rollup-refresh `0 9,12 * * *`. donor_rollup_bulk is the
    // hand-run full rebuild of the same table — folded in so the row covers
    // both writers of the rollup.
    aliases: ["donor_rollup_refresh", "donor_rollup_bulk"],
    cadence: "daily",
    scheduleLabel: "Twice daily, 09:00 + 12:00 UTC",
    blurb:
      "Totals up who funded each official, and how much, so the money views don't re-add every donation on every request.",
    retryCmd: "CALL refresh_official_donor_rollup_incremental();",
  },
  {
    key: "donor_party_rollup_refresh",
    display: "Donor party splits",
    aliases: ["donor_party_rollup_refresh"],
    // cron.job: donor-party-rollup-refresh `0 15 * * 2`.
    cadence: "weekly",
    scheduleLabel: "Tuesdays, 15:00 UTC",
    blurb: "Works out how each donor's giving splits across parties and chambers.",
    retryCmd: "CALL refresh_donor_party_rollup_incremental();",
  },
  {
    key: "financial_entity_totals",
    display: "Donor & PAC totals",
    aliases: ["financial_entity_totals_refresh", "financial_entity_totals_reconcile"],
    // cron.job: financial-entity-totals-incremental `0 10 * * 2` (weekly
    // incremental) + financial-entity-totals-reconcile `0 12 1 * *` (monthly
    // full reconciliation). One row, two writers.
    cadence: "weekly",
    scheduleLabel: "Tuesdays 10:00 UTC, full reconcile monthly",
    blurb:
      "Keeps each donor's and PAC's lifetime given/received totals in step with newly ingested filings.",
    retryCmd: "CALL refresh_financial_entity_totals_incremental();",
  },
  {
    key: "contract_flow_rollups_rebuild",
    display: "Contract flows",
    aliases: ["contract_flow_rollups_rebuild"],
    // cron.job: contract-flow-rollups-refresh `0 14 * * 4`.
    cadence: "weekly",
    scheduleLabel: "Thursdays, 14:00 UTC",
    blurb:
      "Ranks the largest contractor-to-agency spending flows behind the contracts views.",
    retryCmd: "CALL refresh_contract_flow_rollups();",
  },
  {
    key: "treemap_individuals_global_refresh",
    display: "Individual donor treemap",
    aliases: ["treemap_individuals_global_refresh"],
    // cron.job: treemap-individuals-global-refresh `0 14 * * 2`.
    cadence: "weekly",
    scheduleLabel: "Tuesdays, 14:00 UTC",
    blurb:
      "Pre-buckets individual donors by size so the donor treemap renders without a per-request scan.",
    retryCmd: "CALL refresh_treemap_individuals_global();",
  },
  {
    key: "official_vote_stats_rebuild",
    display: "Vote statistics",
    aliases: ["official_vote_stats_rebuild"],
    // cron.job: vote-stats-refresh `30 3 * * *`.
    cadence: "daily",
    scheduleLabel: "Daily, 03:30 UTC",
    blurb:
      "Recomputes each official's vote tallies, attendance and party-line rate from the raw vote records.",
    retryCmd: "CALL rebuild_official_vote_stats();",
  },
  {
    key: "agency_staffing_rollup_refresh",
    display: "Agency staffing rollup",
    aliases: ["agency_staffing_rollup_refresh"],
    // cron.job: agency-staffing-rollup-refresh `0 13 * * 2`.
    cadence: "weekly",
    scheduleLabel: "Tuesdays, 13:00 UTC",
    blurb: "Rolls federal headcount up the agency hierarchy for the agency pages.",
    retryCmd: "CALL refresh_agency_staffing_rollup();",
  },
  {
    key: "refresh_derived_mvs",
    display: "Derived views",
    aliases: ["refresh_derived_mvs"],
    // cron.job: refresh-derived-mvs-daily `0 6 * * *` +
    // refresh-derived-mvs-weekly `0 7 * * 2`. Both CALL refresh_derived_mvs().
    cadence: "daily",
    scheduleLabel: "Daily 06:00 UTC, heavier set Tuesdays 07:00",
    blurb:
      "Refreshes the pre-computed views the homepage, search and graph read from, including this page's own runtime stats.",
    retryCmd: "CALL refresh_derived_mvs('daily');",
  },
  {
    key: "run_rule_taggers",
    display: "Rule taggers",
    aliases: ["run_rule_taggers"],
    // cron.job: rule-taggers-daily `30 6 * * *` + rule-taggers-weekly
    // `0 16 * * 2`.
    cadence: "daily",
    scheduleLabel: "Daily 06:30 UTC, heavier set Tuesdays 16:00",
    blurb:
      "Applies the deterministic (non-AI) classification rules that label donors by industry, officials by committee and so on.",
    retryCmd: "CALL run_rule_taggers('daily');",
  },
  {
    key: "sector_affinity_tag_refresh",
    display: "Sector affinity",
    aliases: ["sector_affinity_tag_refresh", "sector_affinity_rollup_backfill"],
    // No cron.job of its own: FIX-958's trigger fires a targeted rebuild when
    // the industry-tag signature changes, checked on the nightly path. Observed
    // cadence on prod is daily.
    cadence: "daily",
    scheduleLabel: "When industry tags change (checked nightly)",
    blurb:
      "Recomputes how strongly each official's funding leans toward particular industries, whenever the underlying tags move.",
  },
  {
    key: "orphan_sweeps",
    display: "Monthly reconciliation sweeps",
    aliases: [
      "donation_edge_orphan_sweep",
      "donor_rollup_orphan_sweep",
      "donor_party_rollup_orphan_sweep",
      "entity_connection_stats_orphan_sweep",
    ],
    // cron.job: donation-edge-orphan-sweep `30 11 1 * *`,
    // donor-rollup-orphan-sweep `30 12 1 * *`,
    // donor-party-rollup-orphan-sweep `0 13 1 * *`,
    // entity-connection-stats-orphan-sweep `30 13 1 * *`.
    cadence: "monthly",
    scheduleLabel: "1st of the month, 11:30–13:30 UTC",
    blurb:
      "Cross-checks the rollups above against the source records and clears anything left behind by a deleted or merged entity.",
  },
  {
    key: "tag_rules",
    display: "Rule tagger (nightly)",
    aliases: ["tag_rules"],
    cadence: "continuous",
    scheduleLabel: "Nightly, with the ingest run",
    blurb:
      "The nightly leg of rule-based tagging, run alongside the ingests rather than on the database's own schedule.",
    retryCmd: "pnpm data:tag-rules",
  },
  {
    key: "tag_ai",
    display: "AI tagger",
    aliases: ["tag_ai"],
    // Background work lives in enrichment_queue, drained by subagent sessions
    // (see docs/done.log). The pipeline name rarely writes to data_sync_log
    // itself, so `continuous` would always show red; `on_demand` treats "any
    // run logged" as healthy.
    cadence: "on_demand",
    scheduleLabel: "Queue-drained, on demand",
    blurb:
      "Assigns descriptive tags to entities that the deterministic rules can't classify, drawn from a work queue rather than a schedule.",
    dbTotals: (db) => [
      { value: db.entity_tags, label: "entity_tags rows (all categories)" },
    ],
    retryCmd: "pnpm data:tag-ai",
  },
  {
    key: "ai_summaries",
    display: "AI summaries",
    aliases: ["ai_summaries"],
    // Same shape as tag_ai — drained via the enrichment queue.
    cadence: "on_demand",
    scheduleLabel: "Queue-drained, on demand",
    blurb:
      "Writes the plain-language summaries shown on proposals, cached once per document rather than generated per visit.",
    dbTotals: (db) => [{ value: db.ai_summary_cache, label: "summaries cached" }],
    retryCmd: "pnpm data:ai-summaries",
  },
  {
    key: "nightly_dispatch",
    display: "Nightly run dispatch",
    aliases: ["nightly-sync"],
    cadence: "daily",
    scheduleLabel: "Daily, 02:00 UTC",
    blurb:
      "The scheduled trigger that starts each night's ingest run. One entry per night, recorded when the run is handed off.",
  },
  {
    key: "nightly_killed",
    display: "Nightly timeout watchdog",
    aliases: ["nightly_killed"],
    // Only ever writes status='failed' — each row IS a kill record. Registered
    // on_demand so "no entries" is the healthy state rather than a stale one.
    cadence: "on_demand",
    scheduleLabel: "Only when a nightly phase is cut short",
    blurb:
      "Records any night where an ingest phase ran past its time limit and was stopped. Entries here mark a phase that was cut short, not a fault in the watchdog itself.",
  },
  {
    key: "one_off_backfills",
    display: "One-off backfills",
    // Hand-run repair and seeding jobs, each executed once (or a handful of
    // times) to populate or correct a table. No schedule by design — grouped
    // into one row so a completed backfill doesn't look like a stalled
    // scheduled job.
    aliases: [
      "small_dollar_rollup_backfill",
      "treemap_individuals_focused_backfill",
      "recipient_count_reconcile",
      "jurisdictions_boundary_backfill",
    ],
    cadence: "on_demand",
    scheduleLabel: "Run by hand, once",
    blurb:
      "One-time jobs that filled in or corrected a table after a schema or data change. These are expected to sit idle once they've done their job.",
  },
];

// Semantic status map (FIX-720) — re-binds to term-green/term-blue/amber/
// term-red inside the dashboard's terminal scope.
const PIPELINE_STATUS_COLOR: Record<string, string> = {
  complete: "bg-green-ink",
  running: "bg-civic-blue",
  interrupted: "bg-amber",
  failed: "bg-accent",
  pending: "bg-rule/60",
};

// Lookup: writer-side alias → canonical PipelineDef (used to bucket history
// rows whose `pipeline` string matches any alias). Spans BOTH sub-sections,
// and includes retired aliases — a retired name is still "known", it just
// doesn't get a verdict, so it must not fall through to the unregistered
// safety net and get listed twice.
const ALIAS_TO_DEF: Record<string, PipelineDef> = (() => {
  const map: Record<string, PipelineDef> = {};
  for (const def of [...PIPELINES, ...MAINTENANCE]) {
    for (const a of def.aliases) map[a] = def;
    for (const a of def.retiredAliases ?? []) map[a] = def;
  }
  return map;
})();

// ── Self-test display labels ──────────────────────────────────────────────────

// Keyed by the self-test `name` emitted in sections.ts getSelfTests(). Names are
// append-only by contract: a persisted status_snapshot payload is up to one tick
// old, so a name that is renamed rather than retired-and-replaced would render
// unlabelled for that tick and retro-relabel every historical payload. Retired
// names are left out entirely — an unknown name falls back to a de-underscored
// form of itself in the renderer, so the one-tick-old payload still reads fine.
// (Retired FIX-1093: entity_search_finds_warren, warren_has_vote_connections.)
const SELF_TEST_LABELS: Record<string, string> = {
  entity_search_resolves_sampled_official: "Entity search working",
  chord_has_industry_data: "Chord diagram has data",
  senate_vote_edges_present: "Vote connections healthy",
  ai_budget_ok: "AI budget OK",
  nightly_ran_today: "Nightly sync ran today",
  connections_pipeline_healthy: "Connections pipeline healthy",
  derived_edges_match_source: "Derived edges match source",
  cron_jobs_healthy: "Scheduled jobs healthy",
  open_comment_count_sane: "Comment-period count sane",
  search_index_fresh: "Search index fresh",
};

// ── Phase / task data (FIX 4) ────────────────────────────────────────────────

// Rendered until /api/phases resolves. Labels mirror the ## headers in
// docs/PHASE_GOALS.md — they had drifted to a set of names that appear
// nowhere in that document (FIX-1078).
const PHASES_FALLBACK = [
  { name: "Phase 0", label: "Scaffold", pct: 100, done: true },
  { name: "Phase 1", label: "MVP", pct: 88, done: false },
  { name: "Phase 2", label: "Growth", pct: 0, done: false },
  { name: "Phase 3", label: "Social App", pct: 0, done: false },
  { name: "Phase 4", label: "Blockchain", pct: 0, done: false },
  { name: "Phase 5", label: "Global", pct: 0, done: false },
];

const PHASE1_TASKS: Array<{ label: string; done: boolean }> = [
  { label: "Entity connections pipeline", done: true },
  { label: "AI cost management system", done: true },
  { label: "Entity tagging system", done: true },
  { label: "Plain language summaries", done: true },
  { label: "Graph visualization studio (Force, Chord, Treemap, Sunburst, Comparison)", done: true },
  { label: "Nightly auto-sync pipeline", done: true },
  { label: "Vote categorization", done: true },
  { label: "Nomination vote tracking", done: true },
  { label: "Claude diagnostic API", done: true },
  { label: "packages/ui component library", done: true },
  { label: "Dashboard redesign", done: true },
  { label: "Search across all entities", done: false },
  { label: "Basic credit system", done: false },
  { label: "'What does this mean for me'", done: false },
  { label: "User auth via Supabase", done: false },
  { label: "Community commenting", done: false },
  { label: "Position tracking", done: false },
  { label: "Follow officials/agencies", done: false },
];

// ── Pipeline freshness helper ────────────────────────────────────────────────

// Thresholds are expressed in hours. Each tier roughly maps to "one expected
// cycle" (ok), "missed one cycle" (warning), "missed multiple" (error).
function freshnessFor(
  cadence: Cadence,
  completedAt: string | null | undefined,
): "ok" | "warning" | "error" {
  if (!completedAt) {
    // On-demand pipelines that never logged are a soft warning — no expected
    // schedule means we can't call it broken. Everything else is error.
    return cadence === "on_demand" ? "warning" : "error";
  }
  const ageH = (Date.now() - new Date(completedAt).getTime()) / 3_600_000;
  switch (cadence) {
    case "hourly":     return ageH < 2     ? "ok" : ageH < 6     ? "warning" : "error";
    case "daily":      return ageH < 48    ? "ok" : ageH < 96    ? "warning" : "error";
    case "weekly":     return ageH < 192   ? "ok" : ageH < 360   ? "warning" : "error"; // 8d / 15d
    case "monthly":    return ageH < 840   ? "ok" : ageH < 1560  ? "warning" : "error"; // 35d / 65d
    case "quarterly":  return ageH < 2400  ? "ok" : ageH < 3120  ? "warning" : "error"; // 100d / 130d
    case "annual":     return ageH < 9600  ? "ok" : ageH < 12000 ? "warning" : "error"; // 400d / 500d
    case "on_demand":  return "ok"; // any run is fine, indefinite
    case "continuous": return ageH < 24    ? "ok" : ageH < 72    ? "warning" : "error";
  }
}

// ── Activity path → display name ─────────────────────────────────────────────

function pathIcon(path: string): string {
  if (path.startsWith("/officials")) return "officials";
  if (path.startsWith("/proposals")) return "proposals";
  if (path.startsWith("/agencies")) return "agencies";
  if (path.startsWith("/graph")) return "graph";
  return "page";
}

function pathLabel(path: string): string {
  if (path === "/graph") return "Connection Graph";
  if (path.startsWith("/officials/")) return "Official profile";
  if (path.startsWith("/proposals/")) return "Proposal";
  if (path.startsWith("/agencies/")) return "Agency";
  return path;
}

// (Platform cost helpers moved to PlatformCostsSection.tsx)

// ── Sections ─────────────────────────────────────────────────────────────────

function StatsSection({
  database,
  officialsBreakdown,
  openProposalCount,
  chordTotalFlowUsd,
}: {
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
  officialsBreakdown: OfficialsBreakdown;
  openProposalCount: number;
  chordTotalFlowUsd: number;
}) {
  const db = isPartial(database) ? null : database;

  const officialsBreakdownLabel = officialsBreakdown
    ? `${formatNumber(officialsBreakdown.federal)} federal · ${formatNumber(officialsBreakdown.state)} state · ${formatNumber(officialsBreakdown.judges)} judges`
    : "Federal, state & judicial officials";

  return (
    <StatsRow>
      <StatCard
        icon={<Users size={16} />}
        label="Officials"
        value={db?.officials ?? 0}
        formatAs="number"
        href="/officials"
        sublabel={officialsBreakdownLabel}
        loading={!db}
      />
      <StatCard
        icon={<ScrollText size={16} />}
        label="Open Proposals"
        value={openProposalCount}
        formatAs="number"
        href="/proposals?status=open"
        sublabel={
          db
            ? `of ${formatNumber(db.proposals)} total federal regulations`
            : "Federal regulations open for comment"
        }
        loading={!db}
      />
      <StatCard
        icon={<Vote size={16} />}
        label="Votes"
        value={db?.votes ?? 0}
        formatAs="number"
        // FIX-1080 — bare /graph is the empty state. Topics-by-Party is the
        // votes chord that renders globally; votes-and-bills and
        // chord-sector-vote both need focused entities first.
        href="/graph?preset=chord-subject-party"
        sublabel="Congressional votes tracked"
        loading={!db}
      />
      <StatCard
        icon={<DollarSign size={16} />}
        label="Donation Flow"
        value={chordTotalFlowUsd * 100}
        formatAs="usd"
        href="/graph?preset=follow-the-money"
        sublabel="FEC-tracked PAC and individual contributions"
        loading={!db}
      />
    </StatsRow>
  );
}

function CommentPeriodsSection({ openProposals }: { openProposals: OpenProposal[] }) {
  return (
    <SectionCard>
      <SectionHeader
        icon={<Megaphone size={16} />}
        title="Open Comment Periods"
        description="Your voice is public record"
        action={
          openProposals.length > 0
            ? { label: "View all", href: "/proposals?status=open" }
            : undefined
        }
      />
      <div className="mt-4">
        {openProposals.length === 0 ? (
          <EmptyState
            title="No comment periods currently open"
            description="Check back soon — federal agencies regularly open rules for public input."
            action={{ label: "View all proposals", href: "/proposals" }}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {openProposals.map((p) => (
                <CommentPeriodCard
                  key={p.id}
                  id={p.id}
                  title={p.title}
                  agency={p.agency}
                  deadline={p.comment_period_end}
                  href={`/proposals/${p.id}`}
                />
              ))}
            </div>
            <p className="mt-4 text-xs text-ink-soft">
              Submitting a comment is free and always will be.{" "}
              <a href="/proposals?status=open" className="text-accent hover:underline">
                View all open proposals →
              </a>
            </p>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// 7-day status indicator: oldest run on the left, newest on the right.
// Empty squares for pipelines with fewer than 7 logged runs so the visual
// width stays constant — operators can see "no rhythm" pipelines instantly.
function StatusSparkline({ runs }: { runs: PipelineHistoryRun[] }) {
  const ordered = [...runs].reverse();
  const padded: Array<PipelineHistoryRun | null> = [
    ...Array<null>(Math.max(0, 7 - ordered.length)).fill(null),
    ...ordered,
  ].slice(-7);
  return (
    <div className="flex items-center gap-1">
      {padded.map((run, i) => (
        <span
          key={i}
          suppressHydrationWarning
          title={
            run
              ? `${run.status} · ${run.completed_at ? formatRelativeTime(run.completed_at) : "—"} · +${formatNumber(run.rows_inserted ?? 0)}`
              : "no run"
          }
          className={`block h-3 w-3 rounded-sm ${
            run ? PIPELINE_STATUS_COLOR[run.status] ?? "bg-rule/60" : "bg-rule/30"
          }`}
        />
      ))}
    </div>
  );
}

function HealthMetricTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warning" | "error" | "neutral";
}) {
  // text-amber is fine here — this tile only renders inside the dashboard's
  // terminal scope, where amber reads on the dark panel.
  const toneCls =
    tone === "ok"
      ? "text-green-ink"
      : tone === "warning"
      ? "text-amber"
      : tone === "error"
      ? "text-accent"
      : "text-ink";
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-rule/60 bg-paper-2/60 px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

type RowStatus = "complete" | "running" | "interrupted" | "failed" | "pending";

/**
 * FIX-1082/1084 — writer-side statuses the dashboard has to render, mapped onto
 * the five badge states StatusBadge knows, plus the word the badge should show.
 *
 * data_sync_log's vocabulary is wider than the badge's and has grown since this
 * card was built: `partial` (a budget-bounded run that banked its progress and
 * will resume — FIX-1056/1063), `reaped` (a run the stale-row reaper closed
 * without a completion — FIX-944), `skipped` (nothing to do, e.g. the daily
 * EDGAR scan on a quiet day), `dispatched` (a run handed off to CI). Previously
 * all four were cast straight to RowStatus, matched nothing, and rendered with
 * the raw writer-side word.
 *
 * `partial` maps to `interrupted` (amber) rather than `complete` on purpose:
 * the run genuinely did not finish, and amber says "in progress across
 * firings" without claiming failure.
 */
const STATUS_PRESENTATION: Record<string, { badge: RowStatus; label: string }> = {
  complete: { badge: "complete", label: "Complete" },
  running: { badge: "running", label: "Running" },
  interrupted: { badge: "interrupted", label: "Interrupted" },
  failed: { badge: "failed", label: "Failed" },
  pending: { badge: "pending", label: "Pending" },
  partial: { badge: "interrupted", label: "Partial" },
  reaped: { badge: "interrupted", label: "No completion recorded" },
  skipped: { badge: "complete", label: "Nothing to do" },
  dispatched: { badge: "complete", label: "Dispatched" },
};

function presentStatus(status: string | null | undefined): {
  badge: RowStatus;
  label: string;
} {
  if (!status) return { badge: "pending", label: "Pending" };
  return (
    STATUS_PRESENTATION[status] ?? {
      badge: "pending",
      // An unmapped status is shown verbatim rather than swallowed — that is
      // how the next new writer-side status announces itself.
      label: status,
    }
  );
}

type AliasState = {
  alias: string;
  latest: PipelineHistoryRun | null;
  freshness: "ok" | "warning" | "error";
  /** Retired writers are displayed but never ranked. */
  retired: boolean;
};

type RowVerdict = {
  rowStatus: RowStatus;
  worstFreshness: "ok" | "warning" | "error";
  aliasStates: AliasState[];
  worstAlias: string | null;
};

// One verdict per registered PIPELINES row. Worst-status across the def's
// aliases drives the badge — the Congress.gov row reads red when *any* of
// congress_officials / congress_votes / congress_committees / congress is
// stale or failing, instead of going green because one alias completed.
function computeRowVerdict(
  cadence: Cadence,
  perAlias: Record<string, PipelineHistoryRun[]>,
  aliases: string[],
  retiredAliases: string[] = [],
): RowVerdict {
  const retired = new Set(retiredAliases);
  const aliasStates: AliasState[] = [...aliases, ...retiredAliases].map((a) => {
    const latest = perAlias[a]?.[0] ?? null;
    return {
      alias: a,
      latest,
      freshness: freshnessFor(cadence, latest?.completed_at),
      retired: retired.has(a),
    };
  });

  // FIX-1082: rank LIVE aliases only. A retired writer has no runs by
  // definition, `rank` scored that as the row's worst, and `!worst.latest`
  // parked the whole row on "Pending" — permanently, for three rows whose live
  // writers were completing daily.
  const rankable = aliasStates.filter((s) => !s.retired);

  // failed > stale-error > stale-warning > complete > pending
  const rank = (s: AliasState): number => {
    if (s.latest?.status === "failed") return 5;
    if (s.freshness === "error") return 4;
    if (s.freshness === "warning") return 3;
    if (s.latest && s.latest.status === "complete") return 2;
    return 1;
  };

  const worst =
    rankable.length > 0
      ? rankable.reduce((a, b) => (rank(b) > rank(a) ? b : a))
      : null;

  let rowStatus: RowStatus;
  if (!worst || !worst.latest) {
    rowStatus = "pending";
  } else if (worst.latest.status === "failed") {
    rowStatus = "failed";
  } else if (worst.freshness === "error") {
    rowStatus = "failed";
  } else if (worst.freshness === "warning") {
    rowStatus = "interrupted";
  } else {
    rowStatus = presentStatus(worst.latest.status).badge;
  }

  return {
    rowStatus,
    worstFreshness: worst?.freshness ?? "error",
    aliasStates,
    // Only a live alias can be the one "propagating" its status up to the row.
    worstAlias: worst?.alias ?? null,
  };
}

function DataHealthRow({
  def,
  history,
  perAlias,
  verdict,
  database,
  quality,
  runtimeStat,
}: {
  def: PipelineDef;
  history: PipelineHistoryRun[];
  perAlias: Record<string, PipelineHistoryRun[]>;
  verdict: RowVerdict;
  database:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"]
    | null;
  quality:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"]
    | null;
  runtimeStat?: PipelineRuntimeStat;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = history[0] ?? null;
  const prior = history[1] ?? null;

  const { rowStatus, worstFreshness, aliasStates, worstAlias } = verdict;

  const dbResolved = database && !isPartial(database) ? database : null;
  const totals = dbResolved && def.dbTotals ? def.dbTotals(dbResolved) : [];
  const primaryTotal = totals[0] ?? null;
  const lastInserted = latest?.rows_inserted ?? 0;

  // FIX-1082 — the header used to show `latest − prior` rows_inserted, coloured
  // green/red. That number is a BATCH-SIZE difference, not a data-level change:
  // an incremental pipeline whose last run had less new material than the one
  // before it produced a large negative, rendered red, on a public page about
  // data integrity. A −2.5M "Δ" meant "this batch was smaller", and read as
  // "we lost 2.5M rows". The header now shows the run's own absolute
  // rows_inserted; the comparison survives in the expanded panel, explicitly
  // labelled against the prior run.
  const priorInserted = prior?.rows_inserted ?? null;
  const delta = priorInserted != null ? lastInserted - priorInserted : null;
  const latestDurationMs = latest ? runDurationMs(latest) : null;

  const lastFailed = history.find((r) => r.status === "failed" && r.error_message);
  const q = quality && !isPartial(quality) ? quality : null;

  // FIX-390: non-fatal seed warnings (FIX-386 plumbing) ride on a run's
  // metadata.seed_warnings (e.g. the jurisdictions_seed row). Surface them as a
  // yellow sub-status — green-with-warnings, never escalated to red, so they
  // don't touch rowStatus. Read from the most recent run that carries any.
  const seedWarnings: string[] = (() => {
    const runWith = history.find((r) => {
      const w = (r.metadata as { seed_warnings?: unknown } | null | undefined)
        ?.seed_warnings;
      return Array.isArray(w) && w.length > 0;
    });
    const raw = (runWith?.metadata as { seed_warnings?: unknown[] } | undefined)
      ?.seed_warnings;
    return Array.isArray(raw)
      ? raw.filter((w): w is string => typeof w === "string")
      : [];
  })();

  // Right-column timestamp label. For slow cadences we prefix "Current · " on
  // healthy rows so a 16-day-old TIGER doesn't look stale next to a fresh
  // daily pipeline. on_demand with no run reads "Loaded never" to distinguish
  // an unloaded one-shot pipeline from a broken scheduled one.
  let timestampLabel: string;
  if (!latest?.completed_at) {
    timestampLabel = def.cadence === "on_demand" ? "Loaded never" : "never";
  } else if (worstFreshness === "ok" && SLOW_CADENCES.has(def.cadence)) {
    timestampLabel = `Current · ${formatRelativeTime(latest.completed_at)}`;
  } else {
    timestampLabel = formatRelativeTime(latest.completed_at);
  }

  return (
    <div className="border-t border-rule/60 first:border-t-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-start gap-2 sm:gap-3 px-4 sm:px-6 py-3 hover:bg-ink/5 transition-colors text-left"
      >
        <span className="text-ink-soft/70 text-xs w-3 shrink-0 pt-0.5">
          {expanded ? "▾" : "▸"}
        </span>

        {/* FIX-1082 — this header was a chain of fixed-width `shrink-0` spans
            (w-40 + w-52 + w-20 + sparkline + badge + w-28 ≈ 600px) with no
            breakpoints at all, so the whole Data Health card scrolled
            horizontally on any phone. It is now a two-column flex that stacks
            under `sm`: the name and status always stay on the top line, the
            totals/duration wrap underneath, and the sparkline — the least
            legible element at that width — drops below `sm` (the same 7 runs
            are in the expanded panel's table). */}
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-sm font-medium text-ink break-words sm:truncate sm:w-40 sm:shrink-0">
              {def.display}
            </span>
            {/* Total entities — the primary fact for this row. Maintenance rows
                have no dbTotals; they show the size of the last run instead of
                the "no DB mapping" developer note that used to render here. */}
            {primaryTotal ? (
              <span className="tabular-nums sm:w-52 sm:shrink-0">
                <span className="text-sm font-semibold text-ink">
                  {formatNumber(primaryTotal.value)}
                </span>{" "}
                <span className="text-xs text-ink-soft">{primaryTotal.label}</span>
              </span>
            ) : latest ? (
              <span className="tabular-nums sm:w-52 sm:shrink-0">
                <span className="text-sm font-semibold text-ink">
                  {formatNumber(lastInserted)}
                </span>{" "}
                <span className="text-xs text-ink-soft">rows last run</span>
              </span>
            ) : (
              <span className="text-xs text-ink-soft/70 sm:w-52 sm:shrink-0">
                no runs recorded yet
              </span>
            )}
            {/* FIX-1082: run duration, public for the first time. */}
            <span
              className="text-xs tabular-nums text-ink-soft/80 sm:w-24 sm:shrink-0"
              title="Wall-clock duration of the most recent run"
            >
              {latestDurationMs != null ? `ran ${formatDurationMs(latestDurationMs)}` : ""}
            </span>
            <span className="hidden sm:inline-flex">
              <StatusSparkline runs={history} />
            </span>
          </span>
          {/* Plain-language description (maintenance rows) + cadence. */}
          {(def.blurb || def.scheduleLabel) && (
            <span className="mt-1 block text-xs text-ink-soft/80">
              {def.blurb}
              {def.blurb && def.scheduleLabel ? " · " : ""}
              {def.scheduleLabel && (
                <span className="text-ink-soft/70">{def.scheduleLabel}</span>
              )}
            </span>
          )}
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          {seedWarnings.length > 0 && (
            <span
              className="text-[11px] font-medium text-amber bg-amber/15 border border-amber/40 rounded px-1.5 py-0.5"
              title={seedWarnings.join("\n")}
            >
              ⚠ {seedWarnings.length} warning{seedWarnings.length === 1 ? "" : "s"}
            </span>
          )}
          {/* Use the run's own wording ("Partial", "Nothing to do") only when
              the verdict agrees with it. When the verdict is driven by
              staleness instead — freshness can push a row to failed/interrupted
              while its last run says "complete" — fall back to the badge's own
              label so the colour and the word can't contradict each other. */}
          <StatusBadge
            status={rowStatus}
            size="sm"
            label={
              latest && presentStatus(latest.status).badge === rowStatus
                ? presentStatus(latest.status).label
                : undefined
            }
          />
          <span
            className="text-xs text-ink-soft/80 sm:w-28 text-right"
            suppressHydrationWarning
          >
            {timestampLabel}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="bg-paper-2/60 border-t border-rule/60 px-6 py-4 space-y-4">
          {/* Author note (e.g. "no startSync writer yet") if present */}
          {def.note && (
            <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink">
              {def.note}
            </div>
          )}

          {/* FIX-390: non-fatal seed warnings (metadata.seed_warnings, FIX-386).
              Green-with-warnings — listed here, not folded into the row status. */}
          {seedWarnings.length > 0 && (
            <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-ink">
              <div className="font-medium mb-1">
                Seed warnings ({seedWarnings.length}) — non-fatal
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {seedWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Secondary DB totals (3+ wide grid; primary already shown above) */}
          {totals.length > 1 && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {totals.slice(1).map((t) => (
                <div key={t.label} className="text-xs text-ink-soft">
                  <span className="font-semibold text-ink tabular-nums">
                    {formatNumber(t.value)}
                  </span>{" "}
                  <span className="text-ink-soft">{t.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Coverage bars relevant to this pipeline */}
          {def.key === "congress" && q && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <DataQualityBar
                label="FEC ID coverage"
                pct={q.fec_coverage.pct}
                value={q.fec_coverage.has_fec}
                total={q.fec_coverage.total}
                color="green"
              />
              <div className="text-xs text-ink-soft self-end">
                Missing state metadata:{" "}
                <span className="font-medium tabular-nums">
                  {formatNumber(q.missing_state)}
                </span>{" "}
                congress members
              </div>
            </div>
          )}
          {def.key === "fec_bulk" && q && (
            <DataQualityBar
              label="Industry tags on PACs"
              pct={q.industry_tags.pct}
              value={q.industry_tags.tagged}
              total={q.industry_tags.total}
              color="blue"
            />
          )}
          {def.key === "ai_summaries" && dbResolved && (
            <DataQualityBar
              label="AI summaries cached"
              pct={
                dbResolved.proposals > 0
                  ? Math.round((dbResolved.ai_summary_cache / dbResolved.proposals) * 1000) / 10
                  : 0
              }
              value={dbResolved.ai_summary_cache}
              total={dbResolved.proposals}
              color="amber"
            />
          )}

          {/* Per-alias sub-pipeline breakdown (multi-alias defs only). The
              alias that drove the row's worst-status verdict is marked
              ← propagating so the operator can see which writer is dragging
              the rollup down. */}
          {aliasStates.length > 1 && (
            <div>
              <div className="text-xs font-medium text-ink-soft mb-1.5">
                Sub-pipelines ({aliasStates.length}):
              </div>
              <div className="overflow-x-auto rounded-md border border-rule/60 bg-card">
                <table className="w-full min-w-[24rem] text-xs">
                  <tbody className="divide-y divide-rule/60">
                    {aliasStates.map((s) => {
                      const propagating = s.alias === worstAlias;
                      const subStatus: RowStatus = s.retired
                        ? "pending"
                        : !s.latest
                        ? "pending"
                        : s.latest.status === "failed"
                        ? "failed"
                        : s.freshness === "error"
                        ? "failed"
                        : s.freshness === "warning"
                        ? "interrupted"
                        : presentStatus(s.latest.status).badge;
                      return (
                        <tr key={s.alias} className={s.retired ? "opacity-60" : undefined}>
                          <td className="px-3 py-1.5 font-mono text-[11px] text-ink-soft">
                            {s.alias}
                          </td>
                          <td className="px-3 py-1.5">
                            {/* FIX-1082: a retired writer is labelled as retired
                                rather than badged "Pending" — pending implies
                                we are still waiting for it. */}
                            <StatusBadge
                              status={subStatus}
                              size="sm"
                              label={
                                s.retired
                                  ? "Retired"
                                  : s.latest &&
                                      presentStatus(s.latest.status).badge === subStatus
                                    ? presentStatus(s.latest.status).label
                                    : undefined
                              }
                            />
                          </td>
                          <td className="px-3 py-1.5 text-ink-soft tabular-nums whitespace-nowrap" suppressHydrationWarning>
                            {s.latest?.completed_at
                              ? formatRelativeTime(s.latest.completed_at)
                              : s.retired
                                ? "no longer writes"
                                : "no runs recorded"}
                          </td>
                          <td className="px-3 py-1.5 text-amber text-[11px] whitespace-nowrap">
                            {propagating ? "← sets this row's status" : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* FIX-1082: the batch-size comparison that used to sit unlabelled in
              the header, with the label it needed all along. */}
          {delta != null && (
            <div className="text-xs text-ink-soft">
              Last run inserted{" "}
              <span className="font-semibold text-ink tabular-nums">
                {formatNumber(lastInserted)}
              </span>{" "}
              rows —{" "}
              <span className="tabular-nums">
                {delta === 0
                  ? "the same as"
                  : `${formatNumber(Math.abs(delta))} ${delta > 0 ? "more than" : "fewer than"}`}
              </span>{" "}
              the run before it ({formatNumber(priorInserted ?? 0)}). This compares
              batch sizes between two runs, not the total held in the database.
            </div>
          )}

          {/* FIX-1083: 30-day aggregates from pipeline_runtime_stats_mv. */}
          {runtimeStat && runtimeStat.runs_30d > 0 && (
            <div className="text-xs text-ink-soft">
              Last 30 days:{" "}
              <span className="font-semibold text-ink tabular-nums">
                {runtimeStat.runs_30d}
              </span>{" "}
              run{runtimeStat.runs_30d === 1 ? "" : "s"}
              {runtimeStat.success_rate_pct != null && (
                <>
                  {" · "}
                  <span className="font-semibold text-ink tabular-nums">
                    {runtimeStat.success_rate_pct}%
                  </span>{" "}
                  completed
                </>
              )}
              {runtimeStat.p95_duration_ms != null && (
                <> · typical worst case {formatDurationMs(runtimeStat.p95_duration_ms)}</>
              )}
            </div>
          )}

          {/* Last 5 runs */}
          {history.length > 0 ? (
            <div>
              <div className="text-xs font-medium text-ink-soft mb-1.5">Recent runs</div>
              {/* FIX-1082: overflow-x-auto + min-w so the table scrolls inside
                  its own box on a phone instead of widening the whole page. */}
              <div className="overflow-x-auto rounded-md border border-rule/60">
                <table className="w-full min-w-[34rem] text-xs">
                  <thead className="bg-paper-2 text-ink-soft">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">Started</th>
                      <th className="text-right font-medium px-3 py-1.5">Duration</th>
                      <th className="text-right font-medium px-3 py-1.5">Inserted</th>
                      <th className="text-right font-medium px-3 py-1.5">Updated</th>
                      <th className="text-right font-medium px-3 py-1.5">Failed</th>
                      <th className="text-right font-medium px-3 py-1.5">MB</th>
                      <th className="text-left font-medium px-3 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule/60 bg-card">
                    {history.slice(0, 5).map((r, i) => (
                      <tr key={`${r.completed_at ?? r.started_at}-${i}`}>
                        <td className="px-3 py-1.5 text-ink-soft whitespace-nowrap" suppressHydrationWarning>
                          {r.started_at
                            ? new Date(r.started_at).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </td>
                        {/* FIX-1082: completed_at − started_at. Renders "—" for
                            a run with no terminal timestamp (running, or reaped
                            — the reaper deliberately leaves completed_at NULL
                            because elapsed-since-start is an upper bound, not a
                            measurement). */}
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft whitespace-nowrap">
                          {formatDurationMs(runDurationMs(r))}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatNumber(r.rows_inserted ?? 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">
                          {formatNumber(r.rows_updated ?? 0)}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right tabular-nums ${
                            (r.rows_failed ?? 0) > 0 ? "text-accent" : "text-ink-soft/70"
                          }`}
                        >
                          {formatNumber(r.rows_failed ?? 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">
                          {r.estimated_mb != null
                            ? Math.round(Number(r.estimated_mb) * 10) / 10
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5">
                          {/* FIX-1082: was a raw cast of the writer-side status
                              to the badge's five-value union, so `partial`,
                              `reaped`, `skipped` and `dispatched` all fell
                              through unstyled. */}
                          <StatusBadge
                            status={presentStatus(r.status).badge}
                            size="sm"
                            label={presentStatus(r.status).label}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-soft">
              No runs logged in <code>data_sync_log</code> for this pipeline.
            </p>
          )}

          {/* Most recent error */}
          {lastFailed?.error_message && (
            <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
              <div className="text-xs font-medium text-accent mb-0.5">
                Latest failure ·{" "}
                <span suppressHydrationWarning>
                  {lastFailed.completed_at
                    ? formatRelativeTime(lastFailed.completed_at)
                    : "unknown time"}
                </span>
              </div>
              <pre className="text-[11px] text-ink whitespace-pre-wrap break-words font-mono">
                {lastFailed.error_message}
              </pre>
            </div>
          )}

          {/* Footer: source link + retry hint */}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-ink-soft">
            {def.source && (
              <a
                href={def.source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded border border-rule bg-card px-2.5 py-0.5 font-medium hover:border-accent/50 hover:text-accent transition-colors"
              >
                {def.source.label} ↗
              </a>
            )}
            {def.retryCmd && (
              <span className="font-mono text-[11px] text-ink-soft">
                ↻ <code>{def.retryCmd}</code>
              </span>
            )}
            {aliasStates.length > 1 && (
              <span
                className="text-[11px] text-ink-soft/70"
                title="data_sync_log writer-side names that get merged into this row"
              >
                aliases: {def.aliases.join(", ")}
                {def.retiredAliases?.length
                  ? ` (retired: ${def.retiredAliases.join(", ")})`
                  : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DataHealthSection({
  pipelines,
  quality,
  database,
}: {
  pipelines: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["pipelines"];
  quality: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"];
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
}) {
  // FIX-1076: /admin/pipeline-health is a real, working page — it renders
  // 30-day p50/p95/max runtime stats — but it 404s for everyone who is not
  // the configured admin, so the public dashboard was advertising an action
  // that dead-ends for every visitor. Gate it client-side on /api/admin/me
  // rather than at SSR: this page is edge-cached for 30 min (FIX-347), so
  // anything admin-conditional baked into the HTML would be served to
  // whoever warmed the cache.
  const { isAdmin } = useIsAdmin();
  const [hoursUntilNext, setHoursUntilNext] = useState(0);

  useEffect(() => {
    function computeHours() {
      const now = new Date();
      const next2am = new Date(now);
      next2am.setUTCHours(2, 0, 0, 0);
      if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1);
      setHoursUntilNext(Math.round((next2am.getTime() - now.getTime()) / 3_600_000));
    }
    computeHours();
    const interval = setInterval(computeHours, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (isPartial(pipelines)) {
    return (
      <SectionCard>
        <SectionHeader icon={<RefreshCw size={16} />} title="Data Health" status="error" />
        <p className="mt-3 text-sm text-accent">{pipelines.error}</p>
      </SectionCard>
    );
  }

  // Build per-pipeline rows from the canonical PIPELINES registry. For each
  // def, gather every history row whose writer-side `pipeline` string matches
  // any of the def's aliases, then sort newest-first and trim to 7. This is
  // where pipeline-name normalization happens — writer-side inconsistencies
  // (hyphens vs underscores, sub-pipeline subkeys) collapse into one row.
  // `perAlias` preserves per-writer identity so the expanded panel and the
  // worst-status verdict can see each sub-pipeline separately.
  const historyMap = pipelines.history ?? {};
  const runtimeStats = pipelines.runtime_stats ?? {};
  type Row = {
    def: PipelineDef;
    history: PipelineHistoryRun[];
    perAlias: Record<string, PipelineHistoryRun[]>;
    verdict: RowVerdict;
    runtimeStat?: PipelineRuntimeStat;
  };

  const buildRow = (def: PipelineDef): Row => {
    const perAlias: Record<string, PipelineHistoryRun[]> = {};
    const allNames = [...def.aliases, ...(def.retiredAliases ?? [])];
    for (const a of allNames) perAlias[a] = historyMap[a] ?? [];

    // Retired aliases are merged into the DISPLAY history (nothing is hidden)
    // but excluded from the verdict inside computeRowVerdict.
    const merged = allNames.flatMap((a) => historyMap[a] ?? []);
    merged.sort((a, b) => {
      const at = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bt - at;
    });

    return {
      def,
      history: merged.slice(0, 7),
      perAlias,
      verdict: computeRowVerdict(
        def.cadence,
        perAlias,
        def.aliases,
        def.retiredAliases ?? [],
      ),
      // 30-day stats are keyed by writer-side label; a multi-alias row takes
      // its primary alias's stats rather than trying to sum incomparable
      // percentages across different writers.
      runtimeStat: runtimeStats[def.aliases[0] ?? def.key],
    };
  };

  const sourceRows: Row[] = PIPELINES.map(buildRow);
  const maintenanceRows: Row[] = MAINTENANCE.map(buildRow);

  // Any writer-side pipeline string with no registration at all still gets a
  // row — never silently dropped. This is a real safety net: it is how a
  // newly-shipped pipeline announces itself.
  //
  // FIX-1083: it used to announce itself on a PUBLIC page as
  // `<name> (orphan)` with a note telling the reader to go edit
  // DashboardClient.tsx. Both strings are gone. The row now carries an honest
  // neutral label; the operator-facing instruction survives verbatim in the
  // expanded panel's note, where it is useful and not mistakable for a fault.
  const knownAliases = new Set(Object.keys(ALIAS_TO_DEF));
  for (const name of Object.keys(historyMap)) {
    if (knownAliases.has(name)) continue;
    const unregisteredDef: PipelineDef = {
      key: name,
      display: name.replace(/[_-]+/g, " "),
      aliases: [name],
      // on_demand keeps an unknown writer from being flagged red purely because
      // its cadence is unknown — we genuinely don't know what to expect of it.
      cadence: "on_demand",
      scheduleLabel: "Unrecognised writer — recently added",
      blurb:
        "This job is recording runs but hasn't been given a description yet. Its runs are shown here in full while that's sorted out.",
      note:
        "This pipeline is logging to data_sync_log but isn't registered in PIPELINES or MAINTENANCE. Add an entry to apps/civitics/app/dashboard/DashboardClient.tsx to give it a proper display name and DB total.",
    };
    maintenanceRows.push(buildRow(unregisteredDef));
  }

  // Health score: fraction of rows whose worst-status verdict is both complete
  // AND within the cadence's "ok" threshold. Uses the same worst-status
  // semantics as the row badge, so the header metric and the per-row badges
  // can't disagree.
  const scoreOf = (rs: Row[]) => {
    const healthy = rs.filter(
      (r) => r.verdict.rowStatus === "complete" && r.verdict.worstFreshness === "ok",
    ).length;
    return {
      healthy,
      total: rs.length,
      pct: rs.length ? Math.round((healthy / rs.length) * 100) : 0,
    };
  };
  const sourceScore = scoreOf(sourceRows);
  const maintenanceScore = scoreOf(maintenanceRows);
  const toneFor = (pct: number) => (pct >= 80 ? "ok" : pct >= 50 ? "warning" : "error");
  const healthTone = toneFor(
    Math.min(sourceScore.pct, maintenanceScore.pct),
  ) as "ok" | "warning" | "error";
  const rows = [...sourceRows, ...maintenanceRows];

  // Latest run anywhere (for header status)
  const latestAcrossAll = rows
    .map((r) => r.history[0])
    .filter((r): r is PipelineHistoryRun => !!r && !!r.completed_at)
    .sort(
      (a, b) =>
        new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime(),
    )[0];

  // Cron summary
  const cron = pipelines.cron_last_run as Record<string, unknown> | null;
  const cronAt =
    (cron?.["completed_at"] as string | undefined) ??
    (cron?.["started_at"] as string | undefined) ??
    null;
  const cronDurationSec = cron?.["duration_seconds"] as number | undefined;
  const cronCost = cron?.["cost_usd"] as number | undefined;

  const backlog = pipelines.enrichment_backlog ?? {
    pending_tag: 0,
    pending_summary: 0,
    processing: 0,
    stale_processing: 0,
  };
  // backlogTotal stays PENDING-only: pending is the backlog. Claims already
  // held by a worker are in-flight work, not queue depth — folding them in
  // would move the tile's tone thresholds for the wrong reason. Stale claims
  // get their own warning treatment on the sub-line instead.
  const backlogTotal = backlog.pending_tag + backlog.pending_summary;
  const backlogTone =
    backlogTotal > 50_000 ? "warning" : backlogTotal > 0 ? "neutral" : "ok";

  return (
    <SectionCard noPadding>
      <div className="p-6 pb-4">
        <SectionHeader
          icon={<RefreshCw size={16} />}
          title="Data Health"
          status={healthTone === "ok" ? "ok" : healthTone === "warning" ? "warning" : "error"}
          description={
            latestAcrossAll ? (
              <>
                Last sync: <span suppressHydrationWarning>{formatRelativeTime(latestAcrossAll.completed_at!)}</span> · Next
                nightly in <span suppressHydrationWarning>{hoursUntilNext}</span>h
              </>
            ) : (
              "No recent runs found"
            )
          }
          action={
            isAdmin ? { label: "Runtime stats", href: "/admin/pipeline-health" } : undefined
          }
        />

        {/* Top strip */}
        <div className="mt-4 flex flex-wrap gap-2">
          <HealthMetricTile
            label="Data sources"
            value={`${sourceScore.healthy}/${sourceScore.total} fresh`}
            sub={`${sourceScore.pct}% complete and within cadence`}
            tone={toneFor(sourceScore.pct)}
          />
          <HealthMetricTile
            label="Maintenance"
            value={`${maintenanceScore.healthy}/${maintenanceScore.total} fresh`}
            sub={`${maintenanceScore.pct}% complete and within cadence`}
            tone={toneFor(maintenanceScore.pct)}
          />
          <HealthMetricTile
            label="Enrichment backlog"
            value={
              <>
                {formatNumber(backlog.pending_tag)} <span className="text-ink-soft/80 text-sm">tag</span> ·{" "}
                {formatNumber(backlog.pending_summary)} <span className="text-ink-soft/80 text-sm">sum</span>
              </>
            }
            sub={
              // FIX-924: this branch used to test `in_progress`, a status
              // public.enrichment_queue cannot hold, so it always rendered
              // "queue idle" — including while 44 claims sat abandoned since
              // April. Stale claims are called out separately in amber: they
              // are still in-progress rows (so they stay inside the processing
              // total), they just need a human to reclaim them.
              backlog.processing > 0 ? (
                <>
                  {formatNumber(backlog.processing)} in progress
                  {backlog.stale_processing > 0 && (
                    <span className="text-amber">
                      {" · "}
                      {formatNumber(backlog.stale_processing)} stale
                    </span>
                  )}
                </>
              ) : (
                "queue idle"
              )
            }
            tone={backlogTone}
          />
          <HealthMetricTile
            label="Last nightly"
            value={
              <span suppressHydrationWarning>
                {cronAt
                  ? new Date(cronAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    }) +
                    " " +
                    new Date(cronAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </span>
            }
            sub={
              cronAt ? (
                <>
                  {cronDurationSec != null
                    ? cronDurationSec < 60
                      ? `${cronDurationSec}s`
                      : `${Math.round(cronDurationSec / 60)}m`
                    : "—"}
                  {cronCost != null && ` · $${cronCost.toFixed(2)}`}
                </>
              ) : (
                "no cron_last_run recorded"
              )
            }
          />
        </div>
      </div>

      {/* FIX-1083: two sub-sections, both public. "Data sources" is where the
          platform's data comes FROM; "Platform maintenance" is what the
          platform does to it afterwards. Splitting them means a stale rollup
          no longer reads as a broken government feed, and it gives the ~30
          maintenance writers somewhere to live other than the orphan bucket. */}
      <div>
        <DataHealthGroup
          title="Data sources"
          description="Where the data comes from. Each row is a public record system we pull from on a schedule."
          rows={sourceRows}
          database={database}
          quality={quality}
        />
        <DataHealthGroup
          title="Platform maintenance"
          description="What we do with it afterwards — the recurring jobs that derive, total up and cross-check the data behind the site."
          rows={maintenanceRows}
          database={database}
          quality={quality}
        />
      </div>
    </SectionCard>
  );
}

function DataHealthGroup({
  title,
  description,
  rows,
  database,
  quality,
}: {
  title: string;
  description: string;
  rows: Array<{
    def: PipelineDef;
    history: PipelineHistoryRun[];
    perAlias: Record<string, PipelineHistoryRun[]>;
    verdict: RowVerdict;
    runtimeStat?: PipelineRuntimeStat;
  }>;
  database:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"]
    | null;
  quality:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"]
    | null;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-rule">
      <div className="px-4 sm:px-6 py-3 bg-paper-2/40">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
          {title}{" "}
          <span className="text-ink-soft/60 normal-case tracking-normal">
            ({rows.length})
          </span>
        </h3>
        <p className="mt-0.5 text-xs text-ink-soft/80">{description}</p>
      </div>
      {rows.map((r) => (
        <DataHealthRow
          key={r.def.key}
          def={r.def}
          history={r.history}
          perAlias={r.perAlias}
          verdict={r.verdict}
          database={database}
          quality={quality}
          runtimeStat={r.runtimeStat}
        />
      ))}
    </div>
  );
}

function ConnectionHighlightsSection({
  chordFlows,
}: {
  chordFlows: NonNullable<ReturnType<typeof useDashboardData>["data"]>["chordFlows"];
}) {
  if (!chordFlows || chordFlows.length === 0) {
    return (
      <SectionCard>
        <SectionHeader
          icon={<Lightbulb size={16} />}
          title="Notable Connections"
          description="Top donation flows this cycle"
        />
        <div className="mt-4">
          <EmptyState
            title="Connection data loading"
            description="Chord diagram data will appear here once available."
          />
        </div>
      </SectionCard>
    );
  }

  const topFlows = chordFlows.slice(0, 5);

  return (
    <SectionCard>
      <SectionHeader
        icon={<Lightbulb size={16} />}
        title="Notable Connections"
        description="Top donation flows this cycle"
        // FIX-1080 — these rows ARE the industry→party chord's top ribbons, so
        // the graph they open is that chord, not the donor force graph.
        action={{ label: "Explore graph", href: "/graph?preset=chord-donor-industries" }}
      />
      <div className="mt-3 divide-y divide-rule/60">
        {topFlows.map((flow, i) => (
          <ConnectionHighlight
            key={i}
            from={flow.from}
            to={flow.to}
            amountUsd={flow.amount_usd}
            graphHref={
              // FIX-1081 — from_id is the raw industry key; the chord emphasizes
              // that arc on open. getChord only started emitting it in FIX-1081,
              // so keep the fallback for a cached/older payload.
              flow.from_id
                ? `/graph?preset=chord-donor-industries&industry=${encodeURIComponent(flow.from_id)}`
                : "/graph?preset=chord-donor-industries"
            }
          />
        ))}
      </div>
    </SectionCard>
  );
}

function ActivitySection({
  activity,
  totalViews,
  lookbackDays,
}: {
  activity: ActivityRow[];
  totalViews: number;
  lookbackDays: number;
}) {
  return (
    <SectionCard>
      <SectionHeader
        icon={<Eye size={16} />}
        title="Site Activity"
        description={`${formatNumber(totalViews)} human page views in the last ${lookbackDays} days`}
      />
      <div className="mt-3 divide-y divide-rule/60">
        {activity.length === 0 ? (
          <EmptyState title="No activity data" description="Page view data will appear here." />
        ) : (
          activity.map((row, i) => (
            <a
              key={i}
              href={row.path}
              className="block hover:bg-ink/5 transition-colors duration-150 rounded-lg -mx-2 px-2"
            >
              <div className="flex items-start gap-3 py-3">
                <span
                  className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full bg-paper-2 text-ink-soft"
                  aria-hidden="true"
                >
                  <Icon name={pathIcon(row.path)} className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">
                    {pathLabel(row.path)}
                  </p>
                  {/* pathLabel falls through to the raw path for anything it
                      has no friendly name for, which printed the same string
                      twice (FIX-1076). */}
                  {pathLabel(row.path) !== row.path && (
                    <p className="text-xs text-ink-soft truncate">{row.path}</p>
                  )}
                  <p className="text-xs text-ink-soft/80">
                    {`${formatNumber(row.views)} views`}
                  </p>
                </div>
              </div>
            </a>
          ))
        )}
      </div>
    </SectionCard>
  );
}

// PlatformCostsSection is now DB-driven — imported from ./PlatformCostsSection

type PhaseData = { name: string; label: string; pct: number; done: boolean };

function DevelopmentProgressSection() {
  const [phases, setPhases] = useState<PhaseData[]>(PHASES_FALLBACK);
  // FIX-1097 — real recent ships from docs/done.log. Starts EMPTY (no
  // fallback list): phases have a known-good static shape to fall back on,
  // "what shipped last week" does not, and inventing one would publish an
  // unbacked claim. Empty → the block simply does not render.
  const [shipped, setShipped] = useState<ShippedEntry[]>([]);

  useEffect(() => {
    fetch("/api/phases")
      .then((r) => r.json())
      .then((d) => { if (d.phases?.length) setPhases(d.phases as PhaseData[]); })
      .catch(() => {/* keep fallback */});
  }, []);

  useEffect(() => {
    fetch("/api/shipped")
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d.shipped)) setShipped(d.shipped as ShippedEntry[]); })
      .catch(() => {/* section stays hidden */});
  }, []);

  // FIX-1088: the header used to hard-code "Phase 1 of 5" while six bars
  // rendered. M is however many phases came back; N is the first unfinished
  // one (its own name, so "Phase 1" tracks the 0-indexed PHASE_GOALS.md
  // headers), falling back to the last phase once everything is complete.
  const currentPhase =
    phases.find((p) => p.pct < 100) ?? phases[phases.length - 1] ?? null;
  const phaseSummary = currentPhase
    ? `${currentPhase.name} of ${phases.length}`
    : undefined;

  return (
    <SectionCard>
      <SectionHeader icon={<Rocket size={16} />} title="Development Progress" description={phaseSummary} />
      <div className="mt-4 space-y-3">
        {phases.map((phase) => (
          <div key={phase.name}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-ink">
                {phase.name} — {phase.label}
                {phase.done && <span className="ml-2 text-green-ink">✓</span>}
              </span>
              <span className="tabular-nums text-sm text-ink-soft">{phase.pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-rule/30">
              <div
                className={`h-full rounded-full transition-all duration-200 ${
                  phase.done ? "bg-green-ink" : phase.pct > 0 ? "bg-civic-blue" : "bg-rule/60"
                }`}
                style={{ width: `${phase.pct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 border-t border-rule/60 pt-4">
        <p className="mb-2 text-xs font-semibold text-ink-soft">Phase 1 Tasks</p>
        <ul className="space-y-1">
          {PHASE1_TASKS.map((task) => (
            <li key={task.label} className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 text-xs ${
                  task.done ? "text-green-ink" : "text-ink-soft/60"
                }`}
              >
                {task.done ? "✓" : "○"}
              </span>
              <span
                className={`text-xs ${task.done ? "text-ink" : "text-ink-soft"}`}
              >
                {task.label}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* FIX-1097 — Recently shipped, straight off docs/done.log. The phase
          bars and the task list above are both hand-maintained claims about
          progress; this is the append-only record of what actually landed,
          which is the only part of this section nobody can forget to update.
          Hidden entirely when the log is empty or unreadable. */}
      {shipped.length > 0 && (
        <div className="mt-6 border-t border-rule/60 pt-4">
          <p className="mb-2 text-xs font-semibold text-ink-soft">Recently shipped</p>
          <ul className="space-y-2">
            {shipped.map((entry) => (
              <li key={`${entry.sha}-${entry.fixIds[0]}`} className="flex items-start gap-2.5">
                <span className="mt-px shrink-0 font-mono text-[10.5px] tabular-nums text-ink-soft/80">
                  {entry.date.slice(5)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs leading-snug text-ink">{entry.subject}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-ink-soft">
                    <span>
                      {entry.fixIds.length === 1
                        ? entry.fixIds[0]
                        : `${entry.fixIds[0]} +${entry.fixIds.length - 1}`}
                    </span>
                    {entry.verified && (
                      <span className="border border-rule/70 px-1 py-px uppercase tracking-[0.08em]">
                        {entry.verified}
                      </span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ── Platform Story (FIX 1: use chord total_flow_usd) ─────────────────────────

function PlatformStorySection({
  database,
  chordTotalFlowUsd,
}: {
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
  chordTotalFlowUsd: number;
}) {
  const db = isPartial(database) ? null : database;

  function formatFlowUsd(n: number): string {
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
    if (n > 0) return `$${formatNumber(n)}`;
    return null!;
  }

  const flowLabel = formatFlowUsd(chordTotalFlowUsd) ?? (db ? `${formatNumber(db.financial_relationships)} donor records` : null);

  return (
    <SectionCard>
      <SectionHeader title="What Civitics Tracks" />
      <div className="mt-4 space-y-2">
        {[
          flowLabel ? `${flowLabel} in donation flows` : "Donation flows tracked",
          db ? `${formatNumber(db.votes)} congressional votes` : "Congressional votes tracked",
          db ? `${formatNumber(db.proposals)} federal regulations` : "Federal regulations tracked",
          db ? `${formatNumber(db.officials)} officials across federal, state, and judiciary` : "Officials across all levels",
          db ? `${formatNumber(db.entity_connections)} mapped connections` : "Connections mapped",
        ].map((line, i) => (
          <p key={i} className="text-sm text-ink-soft">
            {line}
          </p>
        ))}
      </div>
      <div className="mt-6 border-t border-rule/60 pt-4 space-y-1.5">
        <p className="text-xs text-ink-soft">All data is public record.</p>
        <p className="text-xs text-ink-soft">All source code is open.</p>
        <p className="text-xs text-ink-soft">All civic actions are free.</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <a href="/about/sources" className="text-sm font-medium text-accent hover:underline">
          View data sources →
        </a>
        <a
          href="https://github.com/civitics-platform/civitics"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-accent hover:underline"
        >
          GitHub →
        </a>
      </div>
    </SectionCard>
  );
}

function SelfTestsSection({
  selfTests,
  aiCosts,
}: {
  selfTests: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["self_tests"];
  aiCosts: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["ai_costs"];
}) {
  if (isPartial(selfTests)) {
    return (
      <SectionCard>
        <SectionHeader icon={<CircleCheck size={16} />} title="System Self-Tests" />
        <p className="mt-3 text-sm text-accent">{selfTests.error}</p>
      </SectionCard>
    );
  }

  const costs = isPartial(aiCosts) ? null : aiCosts;
  const allPassed = selfTests.every((t) => t.passed);
  const failedCount = selfTests.filter((t) => !t.passed).length;

  return (
    <SectionCard>
      <SectionHeader
        icon={<CircleCheck size={16} />}
        title="System Self-Tests"
        description="Run on every status check"
        status={allPassed ? "ok" : "error"}
      />
      <ul className="mt-4 space-y-2">
        {selfTests.map((test) => {
          const label = SELF_TEST_LABELS[test.name] ?? test.name.replace(/_/g, " ");
          const displayLabel =
            test.name === "ai_budget_ok" && costs
              ? `AI budget OK (${costs.budget_used_pct.toFixed(0)}% used)`
              : label;
          return (
            <li key={test.name} className="flex items-start gap-2">
              <span
                className={`shrink-0 mt-0.5 ${test.passed ? "text-green-ink" : "text-accent"}`}
                title={test.detail}
              >
                {test.passed
                  ? <CircleCheck size={14} />
                  : <CircleX size={14} />}
              </span>
              <span
                className={`text-sm ${test.passed ? "text-ink-soft" : "text-accent font-medium"}`}
              >
                {displayLabel}
              </span>
            </li>
          );
        })}
      </ul>
      {/* FIX-1084: "— investigating" claimed the same thing the banner did, and
          was false for the same reason: these checks run when the status
          snapshot is built and are reported here, with no alerting hop and
          nobody assigned in between. Say how many failed and leave it there. */}
      <p className="mt-4 text-xs text-ink-soft">
        {allPassed
          ? "All systems operational"
          : `${failedCount} check${failedCount === 1 ? "" : "s"} failing — see the detail above`}
      </p>
    </SectionCard>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DashboardClient({
  openProposals,
  openProposalCount,
  tab,
  initialStatus,
}: DashboardClientProps) {
  const { data, error, refresh } = useDashboardData(initialStatus);
  const [_secondsAgo] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function handleAdminRefresh() {
    setRefreshing(true);
    try {
      await fetch("/api/platform/anthropic", {
        method: "POST",
        headers: {
          // Must use dot notation — Next.js only inlines NEXT_PUBLIC_ with dot access
          "X-Admin-Key": process.env.NEXT_PUBLIC_ADMIN_KEY ?? "admin",
        },
      });
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  const db = data && !isPartial(data.status.database) ? data.status.database : null;

  const officialsBreakdown: OfficialsBreakdown =
    data?.status.officials_breakdown && !isPartial(data.status.officials_breakdown)
      ? (data.status.officials_breakdown as OfficialsBreakdown)
      : null;

  const failedTests =
    data && !isPartial(data.status.self_tests)
      ? data.status.self_tests.filter((t) => !t.passed)
      : [];

  // FIX 1: chord total flow USD
  const chordSection =
    data?.status.chord && !isPartial(data.status.chord) ? data.status.chord : null;
  const chordTotalFlowUsd = chordSection?.total_flow_usd ?? 0;

  const activitySectionData: ActivitySectionData | null =
    data?.status.activity && !isPartial(data.status.activity)
      ? (data.status.activity as ActivitySectionData)
      : null;
  const topPages = activitySectionData?.top_pages ?? [];
  const totalViews = activitySectionData?.page_views ?? 0;
  const lookbackDays = activitySectionData?.lookback_days ?? 7;

  // Shared banners (shown on both tabs when there's a problem)
  const banners = (
    <>
      {failedTests.length > 0 && (
        <AlertBanner
          level="warning"
          // Self-test LABELS are phrased as the HEALTHY assertion ("Connections
          // pipeline healthy") — fine next to a ✓/✗ in the self-test list, but
          // echoing them after "System issue detected:" self-contradicts
          // ("issue detected: … healthy", FIX-725). Name how many checks are
          // failing, then surface each test's own `detail` (the real failure
          // reason) rather than the healthy-phrased label.
          message={`System issue detected — ${failedTests.length} check${failedTests.length === 1 ? "" : "s"} failing`}
          // FIX-1084: "the team has been notified and is investigating" was
          // simply false — nothing notifies anyone from this path. The failing
          // self-test is computed when the status snapshot is built and
          // rendered here; there is no alerting hop in between. Say what
          // actually happened, and point at the section that carries the
          // detail.
          detail={`${failedTests
            .map((t) => t.detail || SELF_TEST_LABELS[t.name] || t.name)
            .join(" · ")} — flagged automatically; see the Data Health section below.`}
        />
      )}
      {error && (
        <AlertBanner
          level="error"
          message="Could not load platform status"
          detail={error}
        />
      )}
    </>
  );

  // FIX-1094: snapshot staleness cue. Everything below this line renders is
  // already in the payload — `meta.fetched_at` is when the status_snapshot row
  // was written — so there is no new request and nothing to keep in sync.
  //
  // This is a cue and not a self-test on purpose: a self-test is computed inside
  // the snapshot, so the only age it could ever report is ~0. Staleness is
  // answerable at read time and nowhere else.
  //
  // Computed on the client after mount (`mounted` gates the whole header), which
  // is also what keeps it honest: an SSR-rendered age would be frozen at the age
  // the HTML was built, and /dashboard is edge-cached for 30 min.
  const snapshotFreshness =
    mounted && data
      ? classifySnapshotAge(
          data.status.meta.fetched_at ?? data.status.meta.timestamp,
          Date.now(),
        )
      : null;

  // Refresh timestamp + admin button (shown on operations tab)
  const opsHeader = mounted && data ? (
    <div className="flex items-center justify-between">
      <p className="font-mono text-xs tabular-nums text-ink-soft/80" suppressHydrationWarning>
        Updated {new Date(data.status.meta.timestamp).toLocaleTimeString()} ·
        {data.status.meta.query_time_ms}ms
        {snapshotFreshness?.label && (
          <span
            className={
              snapshotFreshness.level === "stale"
                ? "ml-2 text-accent font-medium"
                : "ml-2 text-amber"
            }
            title={
              snapshotFreshness.level === "stale"
                ? "Every number on this page is from that snapshot. Treat them as historical until the refresh recovers."
                : "The 10-minute snapshot refresh has missed several ticks; these numbers are not live."
            }
          >
            · {snapshotFreshness.label}
          </span>
        )}
      </p>
      <button
        onClick={handleAdminRefresh}
        disabled={refreshing}
        title="Force refresh all platform data"
        className="text-xs bg-ink/10 text-ink-soft hover:bg-ink/15 hover:text-ink px-2 py-1 rounded transition-colors disabled:opacity-50"
      >
        {refreshing ? "⟳" : "↺ Refresh"}
      </button>
    </div>
  ) : null;

  if (tab === "transparency") {
    return (
      <div className="space-y-6">
        {banners}

        {/* ── Hero: Stat Cards ── */}
        <StatsSection
          database={data?.status.database ?? { error: "Loading", partial: true }}
          officialsBreakdown={officialsBreakdown}
          openProposalCount={openProposalCount}
          chordTotalFlowUsd={chordTotalFlowUsd}
        />

        {/* ── Comment Periods ── */}
        <CommentPeriodsSection openProposals={openProposals} />

        {/* ── Donation Flows ── */}
        <ConnectionHighlightsSection chordFlows={data?.chordFlows ?? []} />

        {/* ── What Civitics Tracks ── */}
        <PlatformStorySection
          database={data?.status.database ?? { error: "Loading", partial: true }}
          chordTotalFlowUsd={chordTotalFlowUsd}
        />
      </div>
    );
  }

  // ── Operations tab ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {banners}
      {opsHeader}

      {/* ── Self-Tests (promoted to top) ── */}
      <SelfTestsSection
        selfTests={data?.status.self_tests ?? { error: "Loading", partial: true }}
        aiCosts={data?.status.ai_costs ?? { error: "Loading", partial: true }}
      />

      {/* ── Unified Data Health (replaces Pipelines + Quality cards) ── */}
      <DataHealthSection
        pipelines={data?.status.pipelines ?? { error: "Loading", partial: true }}
        quality={data?.status.quality ?? { error: "Loading", partial: true }}
        database={data?.status.database ?? { error: "Loading", partial: true }}
      />

      {/* ── Platform Costs ── */}
      <PlatformCostsSection
        platformUsage={data?.platformUsage ?? null}
        onRefresh={refresh}
        anthropicDetail={data?.anthropicDetail ?? null}
        aiCosts={
          data?.status.ai_costs && !isPartial(data.status.ai_costs)
            ? (data.status.ai_costs as AiCosts)
            : null
        }
        chordTotalFlowUsd={chordTotalFlowUsd}
      />

      {/* ── Site Activity ── */}
      <ActivitySection activity={topPages} totalViews={totalViews} lookbackDays={lookbackDays} />

      {/* ── Development Progress ── */}
      <DevelopmentProgressSection />
    </div>
  );
}
