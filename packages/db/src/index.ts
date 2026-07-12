// Clients
export { createServerClient, createBrowserClient, createPublicClient, createAdminClient, createAdminClientWith } from "./client";
export type { CookieStore } from "./client";

// Types
export type { Database, Json } from "./types/database";

// Fail-loud read helpers (FIX-545) — throw-on-error + auto-pagination for
// PostgREST SELECTs that feed downstream Maps/Sets. See read-helpers.ts.
export { rowsOrThrow, selectAllOrThrow } from "./read-helpers";
export type { ReadResult, SelectAllOptions } from "./read-helpers";

// Queries
export {
  getJurisdiction,
  listJurisdictionsByCountry,
  listChildJurisdictions,
  listJurisdictionsUpdatedAfter,
} from "./queries/jurisdictions";

export {
  getGoverningBody,
  listGoverningBodiesByJurisdiction,
  listGoverningBodiesByType,
  currentGoverningBodyMembers,
  CURRENT_MEMBER_TIER,
} from "./queries/governing-bodies";

export {
  getOfficial,
  getOfficialBySourceId,
  listOfficialsByGoverningBody,
  listOfficialsByJurisdiction,
  listOfficialsByParty,
  findOfficialsByLocation,
} from "./queries/officials";

export {
  getAgency,
  getAgencyByAcronym,
  listAgenciesByJurisdiction,
  listAgenciesByType,
  listSubAgencies,
} from "./queries/agencies";

export {
  getProposal,
  getProposalByRegulationsGovId,
  listOpenForComment,
  listProposalsByJurisdiction,
  listProposalsByStatus,
  listProposalsByType,
  listProposalsUpdatedAfter,
  searchProposals,
} from "./queries/proposals";

export {
  getVoteRecord,
  getVoteSummary,
  listVotesByOfficial,
  listVotesByOfficialAndValue,
  listVotesByProposal,
} from "./queries/votes";

export {
  getDonationsByIndustry,
  getTopDonorsByOfficial,
  listDonationsByDonor,
  listDonationsByOfficial,
} from "./queries/financial-relationships";

export {
  fetchIndustryTagsByEntityId,
  fetchEntityIdsByIndustryTag,
} from "./queries/entity-industry";
export type { IndustryTag } from "./queries/entity-industry";

export {
  getAllConnectionsForEntity,
  getConnectionsFrom,
  getConnectionsTo,
  getShortestPath,
  listConnectionsByType,
} from "./queries/entity-connections";
export type { EntityPathSegment } from "./queries/entity-connections";

export {
  getPromise,
  getPromiseSummary,
  listPromisesByOfficial,
  listPromisesByProposal,
  listPromisesByStatus,
} from "./queries/promises";

// PostGIS district lookup (RPC-based)
export {
  findRepresentativesByLocation,
  findJurisdictionsByLocation,
} from "./queries/district-lookup";

// Storage (Supabase now, R2 later — paths are provider-agnostic)
export { getStorageUrl, uploadFile, getFile, fileExists } from "./storage";
// R2 cache bucket helpers (FIX-192) live at `@civitics/db/server-storage` — server-only.

// Platform usage tracking
export {
  getPlatformUsage,
  updateUsage,
  verifyUsage,
  upgradeServicePlan,
  calculateOverageCost,
  getSourceDisplay,
  effectiveLimit,
} from "./platform-usage";
export type {
  PlanTier,
  UsageSource,
  PlatformLimit,
  PlatformUsage,
  PlatformMetric,
  SourceDisplay,
} from "./platform-usage";

// Reference data
export { AGENCY_NAMES, agencyFullName } from "./agency-names";

// Anthropic Admin API usage helper
export {
  getAnthropicUsage,
  getMonthlyAnthropicSpend,
  getMonthlyAnthropicLimitUsd,
  clearMonthlyAnthropicSpendCache,
} from "./anthropic-usage";
export type {
  AnthropicUsageResponse,
  AnthropicUsageSuccess,
  AnthropicUsageError,
  AnthropicWindowUsage,
  AnthropicBudget,
  AnthropicModelUsage,
} from "./anthropic-usage";

// Platform usage snapshot (cron-populated, dashboard-read)
export {
  computePlatformUsagePayload,
  writePlatformUsageSnapshot,
} from "./platform-snapshot";
export type {
  PlatformUsagePayload,
  PlatformUsageSummary,
  PlatformSnapshotResult,
} from "./platform-snapshot";

// DB-backed kill switches
export {
  isKillSwitchEnabled,
  setKillSwitch,
  flipSwitch,
  clearKillSwitchCache,
} from "./kill-switches";
export type {
  KillSwitchName,
  KillSwitchState,
  KillSwitchesMap,
  KillSwitchEventInput,
} from "./kill-switches";

// Auto-trip evaluator (PR 3 / FIX-286)
export { evaluateAutoTrips } from "./auto-trip-evaluator";
export type {
  AutoTripDecision,
  AutoTripAction,
} from "./auto-trip-evaluator";

// Supabase self-metrics (db size, file storage, Management API analytics)
export {
  getSupabaseSqlMetrics,
  getSupabaseManagementMetrics,
  getSupabaseAuthMau,
  clearSupabaseManagementCache,
} from "./supabase-usage";
export type {
  SupabaseSqlMetrics,
  SupabaseSqlMetricsError,
  SupabaseManagementMetrics,
  SupabaseManagementMetricsError,
  SupabaseAuthMau,
  SupabaseAuthMauError,
} from "./supabase-usage";

// Supabase Prometheus metrics (egress + db_connections + disk_used_bytes
// via /customer/v1/privileged/metrics; FIX-349 / FIX-350)
export {
  getSupabasePrometheusMetrics,
  clearSupabasePrometheusCache,
  parsePrometheusText,
  NETWORK_VIRTUAL_DEVICES,
} from "./supabase-prometheus";
export type {
  SupabasePrometheusMetrics,
  SupabasePrometheusMetricsError,
} from "./supabase-prometheus";

// Cloudflare R2 metrics (storage + class-A/B operations via GraphQL Analytics)
export {
  getCloudflareR2Usage,
  clearCloudflareUsageCache,
} from "./cloudflare-usage";
export type {
  CloudflareR2BucketUsage,
  CloudflareR2Usage,
  CloudflareR2UsageError,
} from "./cloudflare-usage";

// Vercel current-cycle usage (Pro Usage endpoint + Billing Charges fallback)
export {
  getVercelUsage,
  clearVercelUsageCache,
} from "./vercel-usage";
export type {
  VercelUsage,
  VercelUsageError,
} from "./vercel-usage";

// GitHub Actions usage (org-level billing minutes + shared-storage)
export {
  getGitHubUsage,
  clearGitHubUsageCache,
} from "./github-usage";
export type {
  GitHubUsage,
  GitHubUsageError,
} from "./github-usage";

// Primary-source materialization helper (FIX-397)
export { refreshPrimarySourceForEntities } from "./primary-source";
export type { PrimarySourceEntityType } from "./primary-source";

// Data attribution (FIX-398) — shared types + SSR helper for detail pages.
// The full xsr expansion lives behind /api/attribution/[type]/[id]; this
// helper returns the cheap (primary + count) shape for the detail-page SSR
// loaders.
export { fetchAttributionForEntity } from "./attribution";
export {
  SOURCE_URL_TEMPLATES,
  ATTRIBUTION_ENTITY_TYPES,
  deriveSourceUrl,
  attributionDetailEndpoint,
} from "./types/attribution";
export type {
  AttributionEntityType,
  AttributionPrimary,
  AttributionShape,
  AttributionDetailSource,
  AttributionDetailResponse,
} from "./types/attribution";

// Source label + category registry (FIX-399 / FIX-400). Label + category
// only — color classes are presentation and live in the UI layer. FIX-400
// extended entries with license metadata + the verbatim LittleSis CC-BY-SA
// attribution text required by FIX-252.
export {
  resolveSource,
  SOURCE_REGISTRY,
  LITTLESIS_ATTRIBUTION_TEXT,
} from "./source-registry";
export type { SourceCategory, SourceRegistryEntry, ResolvedSource } from "./source-registry";

// Unified comment vocabulary (C0 / FIX-520) — allowed kinds per entity_type,
// initiative per-stage vocab, stances, statuses, flag reasons, rate limits.
export {
  ENTITY_COMMENT_TYPES,
  COMMENT_STANCES,
  COMMENT_STATUSES,
  DEFAULT_KIND,
  KIND_LABELS,
  ALLOWED_KINDS,
  INITIATIVE_STAGE_KINDS,
  FLAG_REASONS,
  RATE_LIMITS,
  MIN_POSITIONS_FOR_ROLLUP,
  DELTA_DAILY_CAP,
  MIN_ACCOUNT_AGE_DAYS,
  NEW_ACCOUNT_AGE_HOURS,
  NEW_ACCOUNT_MIN_ACTIONS,
  newAccountCap,
  MAX_THREAD_DEPTH,
  EDIT_WINDOW_MINUTES,
  BODY_MIN,
  BODY_MAX,
  STATEMENT_MIN_LEN,
  STATEMENT_MAX_LEN,
  STATEMENT_SUBMIT_DAILY_CAP,
  SLOW_MODE_COMMENTS_PER_HOUR,
  SLOW_MODE_DURATION_HOURS,
  STATEMENT_VOTES,
  isEntityCommentType,
  isAllowedKind,
  isCommentStance,
  isStatementVote,
  allowedKindsForStage,
  kindLabel,
} from "./comment-kinds";
export type {
  EntityCommentType,
  CommentStance,
  CommentStatus,
  InitiativeStage,
  FlagReason,
  StatementVote,
} from "./comment-kinds";
