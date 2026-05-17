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
  clearKillSwitchCache,
} from "./kill-switches";
export type {
  KillSwitchName,
  KillSwitchState,
  KillSwitchesMap,
} from "./kill-switches";

// Supabase self-metrics (db size, file storage, Management API analytics)
export {
  getSupabaseSqlMetrics,
  getSupabaseManagementMetrics,
  clearSupabaseManagementCache,
} from "./supabase-usage";
export type {
  SupabaseSqlMetrics,
  SupabaseSqlMetricsError,
  SupabaseManagementMetrics,
  SupabaseManagementMetricsError,
} from "./supabase-usage";

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
