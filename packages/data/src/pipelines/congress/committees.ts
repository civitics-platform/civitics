/**
 * Congress.gov committees pipeline (FIX-153).
 *
 * Backfills public.governing_bodies (type='committee') and
 * public.official_committee_memberships from canonical congressional
 * committee data.
 *
 * Source: unitedstates/congress-legislators (used by GovTrack, ProPublica).
 *   - https://unitedstates.github.io/congress-legislators/committees-current.json
 *   - https://unitedstates.github.io/congress-legislators/committee-membership-current.json
 *
 * The Congress.gov v3 /committee endpoint exposes committee metadata but NOT
 * membership lists (verified empirically against /committee/senate/sseg00 —
 * returns history/subcommittees/bills but no members array). The unitedstates
 * feed is the standard public source for committee rosters and updates daily
 * from House/Senate XML feeds.
 *
 * thomas_id ↔ Congress.gov systemCode mapping:
 *   - Parent committees: 4-char thomas_id (e.g. SSAF) → systemCode = lowercase + "00" (ssaf00)
 *   - Subcommittees:     6-char thomas_id (e.g. SSAF13) → systemCode = lowercase (ssaf13)
 *
 * Idempotent: re-running upserts governing_bodies and replaces current
 * (ended_at IS NULL) memberships for the touched committees.
 *
 * Run standalone:  pnpm --filter @civitics/data data:committees
 */

import { createAdminClient, refreshPrimarySourceForEntities } from "@civitics/db";
import type { Database } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";

type GoverningBodyInsert = Database["public"]["Tables"]["governing_bodies"]["Insert"];
type MembershipInsert = Database["public"]["Tables"]["official_committee_memberships"]["Insert"];

// ---------------------------------------------------------------------------
// Source feed types
// ---------------------------------------------------------------------------

interface CommitteesFeedSubcommittee {
  name: string;
  thomas_id: string;        // suffix only (e.g. "13")
  address?: string;
  phone?: string;
}

interface CommitteesFeedCommittee {
  type: "house" | "senate" | "joint";
  name: string;
  url?: string;
  thomas_id: string;        // 4 chars (e.g. "SSAF")
  subcommittees?: CommitteesFeedSubcommittee[];
  jurisdiction?: string;
  phone?: string;
  address?: string;
}

interface MembershipMember {
  name: string;
  party: "majority" | "minority";
  rank: number;
  title?: string;
  bioguide: string;
}

type MembershipFeed = Record<string, MembershipMember[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMITTEES_URL  = "https://unitedstates.github.io/congress-legislators/committees-current.json";
const MEMBERSHIP_URL  = "https://unitedstates.github.io/congress-legislators/committee-membership-current.json";

function thomasIdToSystemCode(thomasId: string): string {
  const lower = thomasId.toLowerCase();
  return lower.length === 4 ? `${lower}00` : lower;
}

function parentSystemCodeFor(parentThomasId: string): string {
  return `${parentThomasId.toLowerCase()}00`;
}

function normalizeRole(title: string | undefined): string {
  if (!title) return "member";
  const t = title.trim().toLowerCase();
  if (t.includes("chair") && t.includes("ranking")) return "ranking_member";
  if (t.includes("ranking")) return "ranking_member";
  if (t.includes("vice")) return "vice_chair";
  if (t.includes("chair")) return "chair";
  return "member";
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export interface CommitteesPipelineOptions {
  federalId: string;
}

export async function runCommitteesPipeline(
  options: CommitteesPipelineOptions
): Promise<PipelineResult> {
  console.log("\n=== Congress committees pipeline ===");
  const logId = await startSync("congress_committees");
  const db = createAdminClient();

  let inserted = 0, updated = 0, failed = 0;

  try {
    // ── 1. Fetch source feeds ───────────────────────────────────────────────
    console.log("  Fetching committees-current.json...");
    const committees = await fetchJson<CommitteesFeedCommittee[]>(COMMITTEES_URL);
    console.log(`    ${committees.length} parent committees`);

    console.log("  Fetching committee-membership-current.json...");
    const membership = await fetchJson<MembershipFeed>(MEMBERSHIP_URL);
    const membershipKeys = Object.keys(membership);
    console.log(`    ${membershipKeys.length} committee/subcommittee membership entries`);

    // ── 2. Flatten committees + subcommittees into a single list ────────────
    type CommitteeRow = {
      thomasId: string;
      systemCode: string;
      name: string;
      chamber: "house" | "senate" | "joint";
      isSubcommittee: boolean;
      parentSystemCode: string | null;
      websiteUrl: string | null;
    };
    const flatCommittees: CommitteeRow[] = [];

    for (const c of committees) {
      const systemCode = thomasIdToSystemCode(c.thomas_id);
      flatCommittees.push({
        thomasId: c.thomas_id,
        systemCode,
        name: c.name,
        chamber: c.type,
        isSubcommittee: false,
        parentSystemCode: null,
        websiteUrl: c.url ?? null,
      });

      for (const sub of c.subcommittees ?? []) {
        const subThomas = `${c.thomas_id}${sub.thomas_id}`;
        flatCommittees.push({
          thomasId: subThomas,
          systemCode: thomasIdToSystemCode(subThomas),
          name: sub.name,
          chamber: c.type,
          isSubcommittee: true,
          parentSystemCode: parentSystemCodeFor(c.thomas_id),
          websiteUrl: null,
        });
      }
    }
    console.log(`  Flattened to ${flatCommittees.length} committees + subcommittees`);

    // ── 3. Pre-fetch existing committees (system_code → governing_body UUID) ─
    const { data: existingCommittees, error: fetchErr } = await db
      .from("governing_bodies")
      .select("id, metadata")
      .eq("type", "committee");

    if (fetchErr) throw new Error(`Failed to fetch existing committees: ${fetchErr.message}`);

    const existingBySystemCode = new Map<string, string>();
    for (const row of (existingCommittees ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
      const code = row.metadata?.["system_code"];
      if (typeof code === "string") existingBySystemCode.set(code, row.id);
    }
    console.log(`  Found ${existingBySystemCode.size} existing committees in governing_bodies`);

    // ── 4. Upsert committees ────────────────────────────────────────────────
    const newCommittees: GoverningBodyInsert[] = [];
    const updates: Array<{ id: string; data: Partial<GoverningBodyInsert> }> = [];

    for (const c of flatCommittees) {
      const data: GoverningBodyInsert = {
        type: "committee",
        name: c.name,
        jurisdiction_id: options.federalId,
        website_url: c.websiteUrl,
        is_active: true,
        metadata: {
          thomas_id: c.thomasId,
          system_code: c.systemCode,
          chamber: c.chamber,
          is_subcommittee: c.isSubcommittee,
          parent_system_code: c.parentSystemCode,
        },
      };

      const existingId = existingBySystemCode.get(c.systemCode);
      if (existingId) {
        updates.push({ id: existingId, data });
      } else {
        newCommittees.push(data);
      }
    }

    // Insert new committees in one batch
    if (newCommittees.length > 0) {
      const { data: insertedRows, error } = await db
        .from("governing_bodies")
        .insert(newCommittees)
        .select("id, metadata");

      if (error) throw new Error(`Failed to insert committees: ${error.message}`);
      inserted += insertedRows?.length ?? 0;

      for (const row of (insertedRows ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
        const code = row.metadata?.["system_code"];
        if (typeof code === "string") existingBySystemCode.set(code, row.id);
      }
      console.log(`  Inserted ${inserted} new committees`);
    }

    // Apply updates one at a time (~230 rows total, no batch endpoint for partial-row updates)
    for (const u of updates) {
      const { error } = await db
        .from("governing_bodies")
        .update(u.data)
        .eq("id", u.id);
      if (error) {
        console.warn(`    update failed for ${u.id}: ${error.message}`);
        failed++;
      } else {
        updated++;
      }
    }
    console.log(`  Updated ${updated} existing committees`);

    // ── 4b. Attribution + hierarchy sidecar (FIX-478 + FIX-481) ─────────────
    // For every committee gb that resolved to an id, write:
    //   (a) external_source_refs (source='congress_gov', external_id=system_code)
    //       → refresh_primary_source_for_entities materializes primary_source*,
    //       so the /institutions/[id] SourceBadge + FIX-400 attribution popover
    //       have a real source row (FIX-481). system_code is the stable congress
    //       id — no synthetic key needed.
    //   (b) institution_extensions (parent_id from the subcommittee's parent
    //       system_code → gb lookup; acronym = thomas_id for parent committees)
    //       → the FIX-418 "Committees & Sub-bodies" sidebar renders children on a
    //       parent page and the parent link on a subcommittee page (FIX-478).
    // Both UPSERT (merge), so re-running is a no-op beyond last_seen_at/updated_at.
    // source_url stays null: congress.gov 403s verification and has no clean
    // per-committee landing — null beats a 404 (same rule as FIX-477).
    // Runs AFTER all inserts+updates so every parent system_code resolves to a gb.
    const resolvedForAttribution = flatCommittees
      .map((c) => ({ c, gbId: existingBySystemCode.get(c.systemCode) }))
      .filter((x): x is { c: (typeof flatCommittees)[number]; gbId: string } => Boolean(x.gbId));

    const committeeXsrRecords = resolvedForAttribution.map(({ c, gbId }) => ({
      source: "congress_gov",
      external_id: c.systemCode,
      entity_type: "governing_body",
      entity_id: gbId,
      source_url: null,
      last_seen_at: new Date().toISOString(),
      metadata: {},
    }));

    const committeeExtRecords = resolvedForAttribution.map(({ c, gbId }) => ({
      governing_body_id: gbId,
      parent_id: c.parentSystemCode ? existingBySystemCode.get(c.parentSystemCode) ?? null : null,
      // The feed has no explicit acronym field; a parent's 4-char thomas_id
      // (e.g. SSAF) reads as the committee's standard shorthand. Subcommittee
      // 6-char codes (SSAF13) are not acronyms → null.
      acronym: c.isSubcommittee ? null : c.thomasId,
    }));

    for (let i = 0; i < committeeXsrRecords.length; i += 500) {
      const { error } = await db
        .from("external_source_refs")
        .upsert(committeeXsrRecords.slice(i, i + 500), { onConflict: "source,external_id" });
      if (error) console.warn(`    committees xsr upsert @${i}: ${error.message}`);
    }
    for (let i = 0; i < committeeExtRecords.length; i += 500) {
      const { error } = await db
        .from("institution_extensions")
        .upsert(committeeExtRecords.slice(i, i + 500), { onConflict: "governing_body_id" });
      if (error) console.warn(`    committees institution_extensions upsert @${i}: ${error.message}`);
    }
    if (resolvedForAttribution.length > 0) {
      await refreshPrimarySourceForEntities(db, "governing_body", resolvedForAttribution.map((x) => x.gbId));
    }
    console.log(
      `  Attribution: ${committeeXsrRecords.length} xsr + ${committeeExtRecords.length} institution_extensions rows`,
    );

    // ── 5. Build bioguide_id → official UUID lookup ─────────────────────────
    const { data: officialsRows, error: officialsErr } = await db
      .from("officials")
      .select("id, source_ids")
      .not("source_ids->>congress_gov", "is", null);

    if (officialsErr) throw new Error(`Failed to fetch officials: ${officialsErr.message}`);

    const officialByBioguide = new Map<string, string>();
    for (const row of (officialsRows ?? []) as Array<{ id: string; source_ids: Record<string, string> | null }>) {
      const bg = row.source_ids?.["congress_gov"];
      if (bg) officialByBioguide.set(bg, row.id);
    }
    console.log(`  Loaded ${officialByBioguide.size} officials with bioguide IDs`);

    // ── 6. Build membership rows ────────────────────────────────────────────
    const membershipsToInsert: MembershipInsert[] = [];
    const committeeIdsTouched = new Set<string>();
    let unmatchedCommittees = 0, unmatchedOfficials = 0;

    for (const [thomasId, members] of Object.entries(membership)) {
      const systemCode = thomasIdToSystemCode(thomasId);
      const committeeId = existingBySystemCode.get(systemCode);
      if (!committeeId) {
        unmatchedCommittees++;
        continue;
      }
      committeeIdsTouched.add(committeeId);

      for (const m of members) {
        const officialId = officialByBioguide.get(m.bioguide);
        if (!officialId) {
          unmatchedOfficials++;
          continue;
        }
        membershipsToInsert.push({
          official_id: officialId,
          committee_id: committeeId,
          role: normalizeRole(m.title),
          started_at: null,
          ended_at: null,
          metadata: { rank: m.rank, party_alignment: m.party },
        });
      }
    }
    console.log(`  Built ${membershipsToInsert.length} membership rows`);
    console.log(`    (skipped: ${unmatchedCommittees} committees w/o governing_body match, ${unmatchedOfficials} bioguide IDs not in officials)`);

    // ── 7. Replace current memberships for touched committees ───────────────
    // Idempotent strategy: delete existing current (ended_at IS NULL) rows for
    // the committees we're refreshing, then insert the new set. Historical
    // rows (ended_at IS NOT NULL) are preserved for future use.
    // FIX-484: chunk the .in() — all ~230 committee UUIDs in one PostgREST
    // delete URL overflows ("URI too long"), which aborted the whole pipeline
    // before any membership landed. 100 ids/chunk keeps the URL well under the
    // ~limit (same convention as the openstates writer LOOKUP_CHUNK_SIZE).
    if (committeeIdsTouched.size > 0) {
      const touchedIds = Array.from(committeeIdsTouched);
      const DELETE_CHUNK = 100;
      for (let i = 0; i < touchedIds.length; i += DELETE_CHUNK) {
        const { error: delErr } = await db
          .from("official_committee_memberships")
          .delete()
          .in("committee_id", touchedIds.slice(i, i + DELETE_CHUNK))
          .is("ended_at", null);
        if (delErr) throw new Error(`Failed to clear current memberships @${i}: ${delErr.message}`);
      }
    }

    // Insert in batches of 500
    let membershipsInserted = 0;
    const BATCH = 500;
    for (let i = 0; i < membershipsToInsert.length; i += BATCH) {
      const batch = membershipsToInsert.slice(i, i + BATCH);
      const { error } = await db
        .from("official_committee_memberships")
        .insert(batch);
      if (error) {
        console.warn(`    membership batch insert failed: ${error.message}`);
        failed += batch.length;
      } else {
        membershipsInserted += batch.length;
      }
    }
    console.log(`  Inserted ${membershipsInserted} memberships across ${committeeIdsTouched.size} committees`);

    const estimatedMb = +(((inserted + updated + membershipsInserted) * 250) / 1024 / 1024).toFixed(2);
    const result: PipelineResult = {
      inserted: inserted + membershipsInserted,
      updated,
      failed,
      estimatedMb,
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  Committees pipeline report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Committees inserted:".padEnd(32)} ${inserted}`);
    console.log(`  ${"Committees updated:".padEnd(32)} ${updated}`);
    console.log(`  ${"Memberships inserted:".padEnd(32)} ${membershipsInserted}`);
    console.log(`  ${"Failed:".padEnd(32)} ${failed}`);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Committees pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted, updated, failed: failed + 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { seedJurisdictions } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    try {
      const { federalId } = await seedJurisdictions(db);
      const result = await runCommitteesPipeline({ federalId });
      console.log("\nCommittees pipeline complete:", result);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
}
