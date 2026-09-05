// Clients
export { createServerClient, createBrowserClient, createPublicClient, createAdminClient, createAdminClientWith } from "./client";
export type { CookieStore } from "./client";

// Types
export type { Database, Json } from "./types/database";

// Fail-loud read helpers (FIX-545) — throw-on-error + auto-pagination for
// PostgREST SELECTs that feed downstream Maps/Sets. See read-helpers.ts.
// Keyset pagination (FIX-984) replaces the OFFSET walks; fetchChunkedByIds
// moved here from apps/civitics/src/lib/paginate.ts (FIX-1037) so packages/
// call sites can bound their `.in()` id lists too.
export {
  rowsOrThrow,
  selectAllOrThrow,
  selectAllKeyset,
  fetchAllKeyset,
  afterKey,
  fetchChunkedByIds,
  ID_CHUNK_SIZE,
  ID_CHUNK_CONCURRENCY,
} from "./read-helpers";
export type {
  ReadResult,
  SelectAllOptions,
  KeysetCursor,
  KeysetOptions,
  KeysetResult,
  ChunkedFetchResult,
} from "./read-helpers";

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
  MERGE_STUB_MARKER_KEYS,
  isMergeStubSourceIds,
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

// FIX-1157 — ./queries/votes and ./queries/financial-relationships are GONE.
// The nine helpers they exported (listVotesByOfficial, listVotesByProposal,
// getVoteRecord, getVoteSummary, listVotesByOfficialAndValue,
// listDonationsByOfficial, getTopDonorsByOfficial, listDonationsByDonor,
// getDonationsByIndustry) had ZERO callers anywhere in apps/, packages/,
// scripts/ or supabase/ — a repo-wide grep on 2026-09-05 found them only in
// their own files, in this export list, and named as findings in two audits.
//
// They were deleted rather than kept, because a reader with no callers is an
// UNAUDITED read path waiting for its first one. The FIX-984 keyset, FIX-1037
// chunking and FIX-760 total-order conventions were all audited by mechanism
// across live readers only, and these nine sat outside that sweep: the FIX-902
// audit had already priced getTopDonorsByOfficial's 1,000-id `.in()` and
// listDonationsByDonor's uncapped `ilike` feed, and the 2026-06-09
// read-degradation audit had already flagged listVotesByProposal /
// getVoteSummary as unbounded at 1,000 rows. Neither was fixed, deliberately —
// fixing pagination in code nothing calls is work with no beneficiary.
//
// If a vote or donation reader is ever needed again, write it against the
// conventions of the day rather than resurrecting these.

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
  computeMetricStatus,
  computeMetricPercents,
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

// Per-metric unit rates + implied cost basis (FIX-1089)
export {
  configuredRateFromLimit,
  measuredRate,
  invoiceItemUsdPerUnit,
  invoiceItemFlatUsd,
} from "./platform-rates";
export type {
  MetricRate,
  RateSource,
  ImpliedCostBasis,
  VercelInvoiceItem,
} from "./platform-rates";

// Per-provider billing cycles (FIX-1089)
export {
  calendarMonthCycle,
  vendorWindowCycle,
  anniversaryCycle,
  isRolling,
} from "./billing-cycles";
export type {
  BillingCycle,
  RollingWindow,
  ProviderCycle,
  CycleSource,
} from "./billing-cycles";

// True monthly cost roll-up (FIX-1089)
export { computePlatformCostTotals } from "./platform-costs";
export type {
  PlatformCostTotals,
  PlatformCostInput,
  SubscriptionItem,
  BillableUsageItem,
  CostContributingMetric,
} from "./platform-costs";

// Recurring subscriptions — the charges that are not metrics (FIX-1089)
export {
  getPlatformSubscriptions,
  updateSubscriptionPrice,
} from "./platform-subscriptions";
export type { SubscriptionsRead } from "./platform-subscriptions";

// Self-counted vendor usage — Mapbox + Resend (FIX-1090)
export {
  recordServiceUsage,
  getServiceSelfCounts,
  currentUsagePeriod,
  mapboxBillableTotal,
  MAPBOX_BILLABLE_METRICS,
} from "./service-self-count";
export type { SelfCounts } from "./service-self-count";

// Vercel account-level billing facts — plan, period, subscription, credit (FIX-1089)
export { getVercelAccount, clearVercelAccountCache } from "./vercel-account";
export type { VercelAccount, VercelAccountError } from "./vercel-account";

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
  getSupabaseOrgBilling,
  clearSupabaseManagementCache,
  clearSupabaseOrgBillingCache,
} from "./supabase-usage";
export type {
  SupabaseSqlMetrics,
  SupabaseSqlMetricsError,
  SupabaseManagementMetrics,
  SupabaseManagementMetricsError,
  SupabaseAuthMau,
  SupabaseAuthMauError,
  SupabaseOrgBilling,
  SupabaseOrgBillingError,
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

// Upstash edge-limiter health (FIX-1038 — the vendor the snapshot could not see)
export {
  getUpstashHealth,
  getUpstashUsage,
  recordUpstashLimiterState,
  isQuotaExhaustedMessage,
  parseQuotaError,
  __resetUpstashHealthCache,
  __resetUpstashUsageCache,
} from "./upstash-usage";
export type {
  UpstashHealth,
  UpstashHealthError,
  UpstashUsage,
  UpstashUsageError,
  UpstashLimiterState,
  UpstashLimiterHistory,
  UpstashLimiterTransition,
} from "./upstash-usage";

// Vercel current-cycle usage (Pro Usage endpoint + Billing Charges fallback)
export {
  getVercelUsage,
  clearVercelUsageCache,
} from "./vercel-usage";
export type {
  VercelUsage,
  VercelUsageError,
} from "./vercel-usage";

// Cloudflare zone analytics + zone settings (FIX-1044/1045 — the leading signal)
export {
  getCloudflareEdgeVolume,
  getZoneSecurityLevel,
  setZoneSecurityLevel,
  probeZoneWriteScope,
  resolveZoneId,
  isScopeError,
  isSecurityLevel,
  SECURITY_LEVEL_RANK,
  __resetCloudflareZoneCache,
} from "./cloudflare-analytics";
export type {
  CloudflareEdgeVolume,
  CloudflareHourBucket,
  CloudflareError,
  SecurityLevel,
  ZoneSecurityLevel,
  ScopeProbeResult,
} from "./cloudflare-analytics";

// Closed-loop Cloudflare auto-mitigation (FIX-1045)
export {
  runCloudflareMitigationLoop,
  decideMitigationAction,
  applyMitigationDecision,
  foldBreaches,
  readMitigationState,
  emptyMitigationState,
  isEmailableMitigationAction,
  scopeProbeIsDue,
  resolveTripThreshold,
  PROBE_SCOPE_INTERVAL_HOURS,
  TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR,
  REQUIRED_BREACH_HOURS,
  BREACH_WINDOW_HOURS,
  REVERT_AFTER_HOURS,
  MIN_HOURS_BETWEEN_TRIPS,
  TARGET_LEVEL,
} from "./cf-mitigation-loop";
export type {
  MitigationAction,
  MitigationDecision,
  MitigationLoopState,
  MitigationRunResult,
  MitigationBreach,
  MitigationTrip,
  MitigationScopeProbe,
} from "./cf-mitigation-loop";

// Vercel Pro billing math — $20 base INCLUDES $20 of usage (FIX-1046)
export {
  computeVercelBilling,
  isPlanBaseService,
  VERCEL_PRO_INCLUDED_USD,
} from "./vercel-billing";
export type { VercelBilling, VercelBillingInput } from "./vercel-billing";

// Daily burn-rate detection (FIX-1044 D2)
export {
  evaluateBurnRate,
  computeBurnRateDeltas,
  readBurnRateSeries,
  BURN_ABSOLUTE_FLOOR_USD,
  BURN_MULTIPLE,
  BURN_TRAILING_DAYS,
} from "./burn-rate";
export type { BurnRateDay, BurnRateDelta, BurnRateVerdict } from "./burn-rate";

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

// AI model pricing — THE single source of truth for prices (FIX-893).
// Lives here (not packages/ai) because @civitics/ai depends on @civitics/db,
// so packages/db cannot import from packages/ai. Re-exported by
// packages/ai/src/cost-config.ts, which stays the entry point for pipelines.
export {
  MODEL_PRICING,
  MAX_KNOWN_PRICING,
  DEFAULT_AI_MODEL,
  UnknownModelPricingError,
  calculateCostUsd,
  calculateLoggedCostUsd,
  hasKnownPricing,
} from "./ai-pricing";
export type { ModelPricing } from "./ai-pricing";

// FIX-1130 — the front-door wedge detector's pure decision logic. The route
// (apps/civitics/app/api/cron/front-door-watch) does the I/O; everything that
// decides lives here so the 2026-08-31 incident is replayable as a test.
export {
  bucketIsRed,
  alignBuckets,
  floorToBucket,
  decideFrontDoorVerdict,
  shouldSend,
  renderFrontDoorEmail,
  FRONT_DOOR_RUNBOOK,
  RED_MIN_52X,
  RED_MIN_52X_RATIO,
  BUCKET_MS,
  BUCKET_COUNT,
} from "./front-door-verdict";
export type {
  FrontDoorBucket,
  FrontDoorProbe,
  FrontDoorVerdict,
} from "./front-door-verdict";
