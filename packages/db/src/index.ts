// Clients
export { createServerClient, createBrowserClient, createPublicClient, createAdminClient, createAdminClientWith } from "./client";
export type { CookieStore } from "./client";

// Types
export type { Database, Json } from "./types/database";

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
