/**
 * FIX-397 — primary_source materialization helper.
 *
 * Pipelines call refreshPrimarySourceForEntities() after a batched
 * external_source_refs upsert. The DB function picks the highest-priority
 * xsr binding per entity (see public.source_priority()) and writes the
 * three primary_source* columns on the corresponding entity row. When
 * called for proposals, it also propagates to child votes.
 *
 * Failure here MUST NOT break the upstream batch upsert — the nightly
 * rebuild_all_primary_sources() safety net (runNightlySync MV block) picks
 * up any drift.
 */

import type { createAdminClient } from "./client";

type Db = ReturnType<typeof createAdminClient>;

export type PrimarySourceEntityType =
  | "official"
  | "proposal"
  | "financial_entity"
  | "agency"
  | "governing_body";

export async function refreshPrimarySourceForEntities(
  db: Db,
  entityType: PrimarySourceEntityType,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any).rpc("refresh_primary_source_for_entities", {
    p_entity_type: entityType,
    p_entity_ids:  entityIds,
  });
  if (error) {
    console.warn(
      `  [primary-source] refresh failed (entity_type=${entityType}, n=${entityIds.length}): ${error.message}`,
    );
  }
}
