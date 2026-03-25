/**
 * Delta connections runner.
 *
 * Only re-derives entity_connections for officials whose votes or financial
 * relationships have changed since the last run. Much faster than a full
 * rebuild on every nightly sync.
 *
 * Uses pipeline_state table to track last_run timestamp.
 * On first run (no state), derives ALL connections (bootstraps).
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:connections-delta
 */

import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { runConnectionsPipeline, voteToConnectionType } from "./index";

const STATE_KEY = "connections_last_run";

// ---------------------------------------------------------------------------
// pipeline_state helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLastRunTimestamp(db: any): Promise<Date | null> {
  try {
    const { data } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();

    if (!data) return null;
    const ts = data.value?.last_run;
    return ts ? new Date(ts as string) : null;
  } catch {
    return null; // pipeline_state table may not exist yet — triggers full rebuild
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setLastRunTimestamp(db: any, ts: Date): Promise<void> {
  try {
    // Merge with existing value so last_vote_id written by the full pipeline is preserved
    const { data: existing } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    const currentValue = ((existing?.value as Record<string, unknown>) ?? {});
    await db.from("pipeline_state").upsert(
      { key: STATE_KEY, value: { ...currentValue, last_run: ts.toISOString() }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  } catch (err) {
    console.error("    Failed to update pipeline_state:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Delta detection: which officials have new data?
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getChangedOfficialIds(db: any, since: Date): Promise<string[]> {
  const sinceIso = since.toISOString();

  const [votesRes, financialsRes] = await Promise.all([
    db.from("votes")
      .select("official_id")
      .gt("created_at", sinceIso),
    db.from("financial_relationships")
      .select("official_id")
      .gt("created_at", sinceIso)
      .not("official_id", "is", null),
  ]);

  const changed = new Set<string>();
  for (const r of votesRes.data ?? [])       changed.add(r.official_id);
  for (const r of financialsRes.data ?? [])  changed.add(r.official_id);
  return Array.from(changed);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runConnectionsDelta(): Promise<PipelineResult> {
  console.log("\n=== Entity connections delta ===");
  const logId = await startSync("connections-delta");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  try {
    const lastRun = await getLastRunTimestamp(db);
    const runStartTime = new Date();

    if (!lastRun) {
      console.log("  No previous run found — running full connections pipeline as bootstrap");
      const result = await runConnectionsPipeline();
      await setLastRunTimestamp(db, runStartTime);
      await completeSync(logId, result);
      return result;
    }

    console.log(`  Last run: ${lastRun.toISOString()}`);
    const changedIds = await getChangedOfficialIds(db, lastRun);

    if (changedIds.length === 0) {
      console.log("  No changed officials since last run. Delta is empty.");
      await setLastRunTimestamp(db, runStartTime);
      const empty: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
      await completeSync(logId, empty);
      return empty;
    }

    console.log(`  ${changedIds.length} officials with new data since ${lastRun.toISOString()}`);

    // For changed officials, run the connections pipeline with targeted scope.
    // The full pipeline re-derives ALL connections. For the delta case, we
    // run targeted sub-queries for only the changed official IDs.

    let totalInserted = 0;
    let totalFailed   = 0;

    // ── Donation connections for changed officials ────────────────────────
    console.log("  Deriving donation connections for changed officials...");
    const { data: financials } = await db
      .from("financial_relationships")
      .select("official_id, donor_name, donor_type, amount_cents, cycle_year, source_url")
      .in("official_id", changedIds)
      .not("official_id", "is", null);

    // Group by (donor_name|donor_type) → financial_entity; (pair) → connection
    const donorTotals = new Map<string, { name: string; type: string; totalCents: number; sourceUrl: string | null }>();
    const donorOfficialPairs = new Map<string, { donorKey: string; officialId: string; totalCents: number; cycles: number[]; sourceUrl: string | null }>();

    for (const row of financials ?? []) {
      const donorName  = String(row.donor_name ?? "").trim().toUpperCase();
      const donorType  = String(row.donor_type ?? "other");
      const officialId = String(row.official_id);
      const amtCents   = Number(row.amount_cents ?? 0);
      const cycle      = row.cycle_year ? Number(row.cycle_year) : null;
      const sourceUrl  = (row.source_url as string | null) ?? null;
      const donorKey   = `${donorName}|${donorType}`;
      const pairKey    = `${donorKey}|${officialId}`;

      const dt = donorTotals.get(donorKey);
      if (dt) { dt.totalCents += amtCents; }
      else     { donorTotals.set(donorKey, { name: donorName, type: donorType, totalCents: amtCents, sourceUrl }); }

      const pair = donorOfficialPairs.get(pairKey);
      if (pair) {
        pair.totalCents += amtCents;
        if (cycle !== null && !pair.cycles.includes(cycle)) pair.cycles.push(cycle);
      } else {
        donorOfficialPairs.set(pairKey, { donorKey, officialId, totalCents: amtCents, cycles: cycle !== null ? [cycle] : [], sourceUrl });
      }
    }

    // Upsert financial_entities + connections
    const donorEntityIds = new Map<string, string>();
    for (const [donorKey, donor] of donorTotals) {
      const { data: existing } = await db.from("financial_entities").select("id").eq("name", donor.name).eq("entity_type", donor.type).maybeSingle();
      if (existing) {
        donorEntityIds.set(donorKey, existing.id);
        await db.from("financial_entities").update({ total_donated_cents: donor.totalCents, updated_at: new Date().toISOString() }).eq("id", existing.id);
      } else {
        const { data: inserted } = await db.from("financial_entities").insert({ name: donor.name, entity_type: donor.type, total_donated_cents: donor.totalCents, source_ids: {} }).select("id").single();
        if (inserted) donorEntityIds.set(donorKey, inserted.id);
      }
    }

    for (const [, pair] of donorOfficialPairs) {
      const financialEntityId = donorEntityIds.get(pair.donorKey);
      if (!financialEntityId) continue;
      const strength = Math.max(0, Math.min(1.0, Math.log10(pair.totalCents / 100000) / 4));
      const { error } = await db.from("entity_connections").upsert({
        from_type: "financial", from_id: financialEntityId,
        to_type: "official", to_id: pair.officialId,
        connection_type: "donation", strength, amount_cents: pair.totalCents,
        evidence: [{ source: "fec", amount_cents: pair.totalCents, election_cycles: pair.cycles, url: pair.sourceUrl ?? "https://www.fec.gov/data/" }],
      }, { onConflict: "from_id,to_id,connection_type" });
      if (error) totalFailed++;
      else totalInserted++;
    }

    // ── Vote connections for changed officials ────────────────────────────
    console.log("  Deriving vote connections for changed officials...");
    const { data: votes } = await db
      .from("votes")
      .select("official_id, proposal_id, vote, voted_at, roll_call_number, chamber, session, source_ids, metadata, proposals!proposal_id(title, vote_category)")
      .in("official_id", changedIds);

    for (const v of votes ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proposal = (v.proposals as any) ?? {};
      const voteCategory = (proposal.vote_category as string | null) ?? null;
      const title = (proposal.title as string | null) ?? null;
      const connType = voteToConnectionType(String(v.vote ?? ""), voteCategory, title, v.metadata);
      if (!connType) continue;

      const sourceIds = (v.source_ids as Record<string, string>) ?? {};
      const rollCallKey = sourceIds["roll_call"] ?? sourceIds["house_clerk_url"] ?? sourceIds["senate_lis_url"] ?? null;

      const { error } = await db.from("entity_connections").upsert({
        from_type: "official", from_id: String(v.official_id),
        to_type: "proposal", to_id: String(v.proposal_id),
        connection_type: connType, strength: 1.0,
        evidence: [{ source: "congress_gov", vote_date: v.voted_at ?? null, roll_call: v.roll_call_number ?? null, chamber: v.chamber ?? null, session: v.session ?? null, roll_call_key: rollCallKey }],
      }, { onConflict: "from_id,to_id,connection_type" });
      if (error) totalFailed++;
      else totalInserted++;
    }

    await setLastRunTimestamp(db, runStartTime);

    const result: PipelineResult = { inserted: totalInserted, updated: 0, failed: totalFailed, estimatedMb: 0 };
    console.log(`  Delta complete: ${totalInserted} connections upserted, ${totalFailed} failed`);

    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Delta connections fatal error:", msg);
    await failSync(logId, msg);
    return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runConnectionsDelta()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
