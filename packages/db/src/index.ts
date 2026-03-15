// Clients
export { createServerClient, createBrowserClient, createAdminClient } from "./client";
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
