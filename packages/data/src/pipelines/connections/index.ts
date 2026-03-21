/**
 * Entity connections derivation pipeline.
 *
 * Derives entity_connections from existing structured data — no external API calls.
 * Run after all data ingestion pipelines have populated the DB.
 *
 * Derives 4 connection types:
 *   donation            — financial_relationships → financial_entity → official
 *   vote_yes/no/abstain — votes table → official → proposal
 *   nomination_vote_yes/no — votes on nomination proposals → official → proposal
 *   oversight           — agencies.governing_body_id → governing_body → agency
 *   appointment         — officials with agency-leadership role titles → agency
 *
 * All phases use batch upserts (500 rows/call) — never sequential per-row calls.
 * Supabase free-tier statement timeout: ~8s. 500 rows × ~10ms = ~5s (safe margin).
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:connections
 */

import { createAdminClient } from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  type PipelineResult,
} from "../sync-log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rows fetched per PostgREST page (server cap is 1 000). */
const FETCH_SIZE = 1000;

/** Rows per upsert call — keeps each request well under the 8s timeout. */
const UPSERT_SIZE = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionCounts {
  donation:            number;
  vote_yes:            number;
  vote_no:             number;
  vote_abstain:        number;
  nomination_vote_yes: number;
  nomination_vote_no:  number;
  oversight:           number;
  appointment:         number;
  failed:              number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Donation strength formula.
 *   $10k  → 0.25   $100k → 0.50   $1M → 0.75   $10M+ → 1.0
 */
function donationStrength(amountCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.max(0, Math.min(1.0, Math.log10(amountCents / 100000) / 4));
}

const PROCEDURAL_QUESTIONS = [
  "on the cloture motion",
  "on passage",
  "on the amendment",
  "on the conference report",
  "on the joint resolution",
  "on the resolution",
  "on the motion",
  "on the motion to proceed",
  "on the motion to table",
  "on the nomination",
  "on the motion to recommit",
  "on agreeing to the amendment",
];

/**
 * Map votes.vote + vote_category + metadata->vote_question to connection_type.
 * Returns null to skip procedural votes and unrecognised values.
 *
 * votes.vote values are lowercase: 'yes' | 'no' | 'present' | 'not voting'
 * metadata->>'vote_question' contains the procedural type string from Congress.gov
 */
function voteToConnectionType(
  vote: string,
  voteCategory: string | null,
  title: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any,
): string | null {
  const voteQuestion: string = (metadata?.vote_question ?? "").toLowerCase();

  // Skip procedural by vote_category OR vote_question
  if (
    voteCategory === "procedural" ||
    PROCEDURAL_QUESTIONS.includes(voteQuestion)
  ) return null;

  // Nomination votes — by vote_category, vote_question, or title
  const isNomination =
    voteCategory === "nomination" ||
    voteQuestion.includes("nomination") ||
    (title?.toLowerCase().includes("nomination") ?? false) ||
    (title?.toLowerCase().includes("confirming") ?? false);

  if (vote === "yes") return isNomination ? "nomination_vote_yes" : "vote_yes";
  if (vote === "no")  return isNomination ? "nomination_vote_no"  : "vote_no";
  if (vote === "present" || vote === "not voting" || vote === "abstain") return "vote_abstain";
  return null;
}

/** Role titles that suggest agency head / cabinet-level appointment. */
const LEADERSHIP_KEYWORDS = [
  "secretary",
  "administrator",
  "director",
  "commissioner",
  "chair",
  "chairman",
  "attorney general",
  "surgeon general",
  "comptroller",
  "treasurer",
  "postmaster",
];

function isAgencyLeadershipRole(roleTitle: string): boolean {
  const lower = roleTitle.toLowerCase();
  return LEADERSHIP_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Batch-upsert rows into entity_connections using the unique triple constraint.
 * Logs per-batch progress every `logEvery` batches.
 */
async function batchUpsertConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  rows: Record<string, unknown>[],
  counts: ConnectionCounts,
  label: string,
  logEvery = 5,
): Promise<void> {
  const total    = rows.length;
  let batchNum   = 0;
  const MAX_RETRIES = 3;

  for (let i = 0; i < total; i += UPSERT_SIZE) {
    batchNum++;
    const chunk = rows.slice(i, i + UPSERT_SIZE);

    let error = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await db
        .from("entity_connections")
        .upsert(chunk, { onConflict: "from_id,to_id,connection_type" });
      error = result.error;
      if (!error) break;
      // Don't retry non-timeout errors (e.g. constraint violations)
      if (!error.message.includes("timeout")) break;
      if (attempt < MAX_RETRIES) {
        console.log(`    [${label}] batch ${batchNum} timeout, retrying (attempt ${attempt + 1})...`);
      }
    }

    if (error) {
      console.error(`    [${label}] batch ${batchNum} error:`, error.message);
      counts.failed += chunk.length;
    } else {
      for (const row of chunk) {
        const ct = row.connection_type as string;
        if      (ct === "donation")             counts.donation++;
        else if (ct === "vote_yes")             counts.vote_yes++;
        else if (ct === "vote_no")              counts.vote_no++;
        else if (ct === "nomination_vote_yes")  counts.nomination_vote_yes++;
        else if (ct === "nomination_vote_no")   counts.nomination_vote_no++;
        else if (ct === "vote_abstain")         counts.vote_abstain++;
        else if (ct === "oversight")            counts.oversight++;
        else if (ct === "appointment")          counts.appointment++;
      }
      if (batchNum % logEvery === 0 || i + UPSERT_SIZE >= total) {
        const done = Math.min(i + UPSERT_SIZE, total);
        console.log(
          `    Batch ${batchNum}/${Math.ceil(total / UPSERT_SIZE)} ✓  (${done}/${total})`
        );
      }
    }

    // Throttle to avoid disk I/O spikes on Supabase free tier.
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// 1. Donation connections
// ---------------------------------------------------------------------------

async function deriveDonationConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  counts: ConnectionCounts
): Promise<void> {
  console.log("\n  [1/4] Donation connections...");

  // ── Step 1: Load all financial_relationships (paginated) ─────────────────
  let page = 0;
  const rows: {
    official_id: string; donor_name: string; donor_type: string;
    amount_cents: number; cycle_year: number | null;
    source_url: string | null; fec_committee_id: string | null;
  }[] = [];

  while (true) {
    const { data: batch, error } = await db
      .from("financial_relationships")
      .select("official_id, donor_name, donor_type, amount_cents, cycle_year, source_url, fec_committee_id")
      .not("official_id", "is", null)
      .range(page * FETCH_SIZE, page * FETCH_SIZE + FETCH_SIZE - 1);

    if (error) { console.error("    Error fetching financial_relationships:", error.message); return; }
    if (!batch || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < FETCH_SIZE) break;
    page++;
  }

  if (rows.length === 0) {
    console.log("    No financial_relationships found. Skipping.");
    return;
  }
  console.log(`    Loaded ${rows.length} financial_relationship records`);

  // ── Step 2: Aggregate in memory ──────────────────────────────────────────
  const donorTotals = new Map<string, { name: string; type: string; totalCents: number }>();
  const donorOfficialPairs = new Map<string, {
    donorKey: string; officialId: string; totalCents: number;
    cycles: number[]; sourceUrl: string | null;
  }>();

  for (const row of rows) {
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
    else     { donorTotals.set(donorKey, { name: donorName, type: donorType, totalCents: amtCents }); }

    const pair = donorOfficialPairs.get(pairKey);
    if (pair) {
      pair.totalCents += amtCents;
      if (cycle !== null && !pair.cycles.includes(cycle)) pair.cycles.push(cycle);
    } else {
      donorOfficialPairs.set(pairKey, {
        donorKey, officialId, totalCents: amtCents,
        cycles: cycle !== null ? [cycle] : [], sourceUrl,
      });
    }
  }

  console.log(`    ${donorTotals.size} unique donors, ${donorOfficialPairs.size} donor→official pairs`);

  // ── Step 3: Batch upsert financial_entities ──────────────────────────────
  // Omit source_ids — DB default '{}' is used for new rows; existing rows preserve theirs.
  const entityUpsertRows = [...donorTotals.values()].map((d) => ({
    name:                d.name,
    entity_type:         d.type,
    total_donated_cents: d.totalCents,
    updated_at:          new Date().toISOString(),
  }));

  console.log(`    Upserting ${entityUpsertRows.length} financial entities...`);
  for (let i = 0; i < entityUpsertRows.length; i += UPSERT_SIZE) {
    const chunk = entityUpsertRows.slice(i, i + UPSERT_SIZE);
    const { error } = await db
      .from("financial_entities")
      .upsert(chunk, { onConflict: "name,entity_type" });

    if (error) {
      console.error(`    financial_entities batch error:`, error.message);
      counts.failed += chunk.length;
    } else {
      const done = Math.min(i + UPSERT_SIZE, entityUpsertRows.length);
      const total = entityUpsertRows.length;
      console.log(`    Batch ${Math.ceil((i + 1) / UPSERT_SIZE)}/${Math.ceil(total / UPSERT_SIZE)} ✓  (${done}/${total})`);
    }
  }

  // ── Step 4: Fetch all entity IDs (paginated) ─────────────────────────────
  const entityIdMap = new Map<string, string>(); // donorKey → UUID
  let idPage = 0;
  while (true) {
    const { data: idBatch, error } = await db
      .from("financial_entities")
      .select("id, name, entity_type")
      .range(idPage * FETCH_SIZE, idPage * FETCH_SIZE + FETCH_SIZE - 1);

    if (error) { console.error("    Error fetching entity IDs:", error.message); break; }
    if (!idBatch || idBatch.length === 0) break;
    for (const e of idBatch) {
      entityIdMap.set(`${String(e.name).toUpperCase().trim()}|${e.entity_type}`, String(e.id));
    }
    if (idBatch.length < FETCH_SIZE) break;
    idPage++;
  }
  console.log(`    Loaded ${entityIdMap.size} entity IDs`);

  // ── Step 5: Build connection rows ─────────────────────────────────────────
  const connectionRows: Record<string, unknown>[] = [];
  for (const [, pair] of donorOfficialPairs) {
    const financialEntityId = entityIdMap.get(pair.donorKey);
    if (!financialEntityId) continue;
    connectionRows.push({
      from_type:       "financial",
      from_id:         financialEntityId,
      to_type:         "official",
      to_id:           pair.officialId,
      connection_type: "donation",
      strength:        donationStrength(pair.totalCents),
      amount_cents:    pair.totalCents,
      evidence: [{
        source:          "fec",
        amount_cents:    pair.totalCents,
        election_cycles: pair.cycles,
        url:             pair.sourceUrl ?? "https://www.fec.gov/data/",
      }],
    });
  }

  // ── Step 6: Batch upsert connections ─────────────────────────────────────
  console.log(`    Upserting ${connectionRows.length} donation connections...`);
  await batchUpsertConnections(db, connectionRows, counts, "donation", 5);
  console.log(`    Created/updated: ${counts.donation} donation connections`);
}

// ---------------------------------------------------------------------------
// 2. Vote connections
// ---------------------------------------------------------------------------

async function deriveVoteConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  counts: ConnectionCounts
): Promise<void> {
  console.log("\n  [2/4] Vote connections...");

  // Cursor-based pagination — avoids the O(n) offset-scan that causes timeouts
  // at high page numbers. Each page fetches rows WHERE id > lastId ORDER BY id.
  // JOIN to proposals brings vote_category + title for connection-type determination.
  const MAX_RETRIES = 3;
  let lastId: string | null = null;
  let pageNum = 0;
  let totalFetched = 0;

  while (true) {
    pageNum++;

    // ── Fetch page with retry ──────────────────────────────────────────────
    let votes: Record<string, unknown>[] | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let q = db
        .from("votes")
        .select("id, official_id, proposal_id, vote, voted_at, metadata, proposals!proposal_id(title, vote_category)")
        .order("id")
        .limit(FETCH_SIZE);
      if (lastId) q = q.gt("id", lastId);

      const { data, error } = await q;
      if (!error) { votes = data; break; }
      if (attempt < MAX_RETRIES) {
        console.log(`    Fetch page ${pageNum} attempt ${attempt} failed (${error.message}), retrying...`);
      } else {
        console.error(`    Error fetching votes page ${pageNum} after ${MAX_RETRIES} attempts:`, error.message);
      }
    }

    if (!votes || votes.length === 0) {
      if (pageNum === 1) console.log("    No votes found. Skipping.");
      break;
    }
    lastId = String(votes[votes.length - 1]["id"]);
    totalFetched += votes.length;

    const rowsThisPage = votes.length;
    const estimatedMB = (rowsThisPage * 500) / 1_000_000;
    console.log(`    Page ${pageNum}: ${rowsThisPage} rows (~${estimatedMB.toFixed(2)}MB egress this page)`);

    // ── Build batch rows ──────────────────────────────────────────────────
    // Deduplicate by (from_id, to_id, connection_type) within the page.
    // The votes table can contain multiple rows for the same (official, proposal, vote)
    // from different roll call records; Postgres rejects a batch that contains the
    // same conflict key more than once.
    const batchMap = new Map<string, Record<string, unknown>>();
    for (const v of votes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proposal     = (v.proposals as any) ?? {};
      const voteCategory = (proposal.vote_category as string | null) ?? null;
      const title        = (proposal.title as string | null) ?? null;
      const connType     = voteToConnectionType(String(v.vote ?? ""), voteCategory, title, v.metadata);
      if (!connType) continue;

      const fromId = String(v.official_id);
      const toId   = String(v.proposal_id);
      const dedupeKey = `${fromId}|${toId}|${connType}`;
      if (batchMap.has(dedupeKey)) continue; // keep first occurrence

      batchMap.set(dedupeKey, {
        from_type:       "official",
        from_id:         fromId,
        to_type:         "proposal",
        to_id:           toId,
        connection_type: connType,
        strength:        1.0,
        evidence: [{
          source:    "congress_gov",
          vote_date: v.voted_at ?? null,
        }],
      });
    }

    const batch = [...batchMap.values()];
    await batchUpsertConnections(db, batch, counts, `vote page ${pageNum}`, 999);

    if (pageNum % 10 === 0) {
      console.log(
        `    Fetched ${totalFetched} votes... ` +
        `(yes: ${counts.vote_yes}, no: ${counts.vote_no}, ` +
        `nom_yes: ${counts.nomination_vote_yes}, nom_no: ${counts.nomination_vote_no}, ` +
        `abstain: ${counts.vote_abstain})`
      );
    }

    if (votes.length < FETCH_SIZE) break;

    // Brief pause between pages to avoid IO spikes.
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(
    `    Created/updated: ${counts.vote_yes} vote_yes, ${counts.vote_no} vote_no, ` +
    `${counts.nomination_vote_yes} nomination_vote_yes, ${counts.nomination_vote_no} nomination_vote_no, ` +
    `${counts.vote_abstain} vote_abstain`
  );
}

// ---------------------------------------------------------------------------
// 3. Oversight connections
// ---------------------------------------------------------------------------

async function deriveOversightConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  counts: ConnectionCounts
): Promise<void> {
  console.log("\n  [3/4] Oversight connections...");

  const { data: agencies, error } = await db
    .from("agencies")
    .select("id, governing_body_id")
    .not("governing_body_id", "is", null);

  if (error) { console.error("    Error fetching agencies:", error.message); return; }
  if (!agencies || agencies.length === 0) {
    console.log("    No agencies with governing_body_id. Skipping.");
    return;
  }
  console.log(`    Processing ${agencies.length} agency→governing_body relationships`);

  const batch = (agencies as { id: string; governing_body_id: string }[]).map((agency) => ({
    from_type:       "governing_body",
    from_id:         String(agency.governing_body_id),
    to_type:         "agency",
    to_id:           String(agency.id),
    connection_type: "oversight",
    strength:        1.0,
    evidence:        [{ source: "inferred", relationship: "oversight_body" }],
  }));

  await batchUpsertConnections(db, batch, counts, "oversight", 1);
  console.log(`    Created/updated: ${counts.oversight} oversight connections`);
}

// ---------------------------------------------------------------------------
// 4. Appointment connections (official → agency)
// Matches officials with agency-leadership role titles to the agencies whose
// governing_body they belong to. Produces 0 results until cabinet officials /
// agency heads are ingested — the code is correct and ready for that data.
// ---------------------------------------------------------------------------

async function deriveAppointmentConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  counts: ConnectionCounts
): Promise<void> {
  console.log("\n  [4/4] Appointment connections...");

  const { data: officials, error: offErr } = await db
    .from("officials")
    .select("id, role_title, governing_body_id")
    .eq("is_active", true)
    .not("governing_body_id", "is", null);

  if (offErr) { console.error("    Error fetching officials:", offErr.message); return; }

  const leaders = (officials ?? []).filter(
    (o: { role_title: string | null }) => o.role_title && isAgencyLeadershipRole(o.role_title)
  );

  if (leaders.length === 0) {
    console.log(
      "    No agency-leadership officials found (cabinet/agency-head data not yet ingested). Skipping."
    );
    return;
  }
  console.log(`    Found ${leaders.length} officials with agency-leadership role titles`);

  const { data: agencies, error: agErr } = await db
    .from("agencies")
    .select("id, name, governing_body_id")
    .not("governing_body_id", "is", null);

  if (agErr) { console.error("    Error fetching agencies:", agErr.message); return; }

  const agenciesByGovBody = new Map<string, Array<{ id: string; name: string }>>();
  for (const ag of agencies ?? []) {
    const list = agenciesByGovBody.get(String(ag.governing_body_id)) ?? [];
    list.push({ id: String(ag.id), name: String(ag.name) });
    agenciesByGovBody.set(String(ag.governing_body_id), list);
  }

  const batch: Record<string, unknown>[] = [];
  for (const official of leaders) {
    const linkedAgencies = agenciesByGovBody.get(String(official.governing_body_id)) ?? [];
    for (const agency of linkedAgencies) {
      batch.push({
        from_type:       "official",
        from_id:         String(official.id),
        to_type:         "agency",
        to_id:           agency.id,
        connection_type: "appointment",
        strength:        1.0,
        evidence: [{
          source:      "inferred",
          role_title:  official.role_title,
          agency_name: agency.name,
        }],
      });
    }
  }

  await batchUpsertConnections(db, batch, counts, "appointment", 1);
  console.log(`    Created/updated: ${counts.appointment} appointment connections`);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runConnectionsPipeline(): Promise<PipelineResult> {
  console.log("\n=== Entity connections pipeline ===");
  const logId = await startSync("connections");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  const counts: ConnectionCounts = {
    donation:            0,
    vote_yes:            0,
    vote_no:             0,
    vote_abstain:        0,
    nomination_vote_yes: 0,
    nomination_vote_no:  0,
    oversight:           0,
    appointment:         0,
    failed:              0,
  };

  try {
    await deriveDonationConnections(db, counts);
    await deriveVoteConnections(db, counts);
    await deriveOversightConnections(db, counts);
    await deriveAppointmentConnections(db, counts);

    const total =
      counts.donation +
      counts.vote_yes +
      counts.vote_no +
      counts.vote_abstain +
      counts.nomination_vote_yes +
      counts.nomination_vote_no +
      counts.oversight +
      counts.appointment;

    const result: PipelineResult = {
      inserted:    total,
      updated:     0,
      failed:      counts.failed,
      estimatedMb: 0,
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  Entity connections report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Total connections created/updated:".padEnd(36)} ${total}`);
    console.log(`  ${"donation:".padEnd(36)} ${counts.donation}`);
    console.log(`  ${"vote_yes (legislation):".padEnd(36)} ${counts.vote_yes}`);
    console.log(`  ${"vote_no (legislation):".padEnd(36)} ${counts.vote_no}`);
    console.log(`  ${"vote_abstain:".padEnd(36)} ${counts.vote_abstain}`);
    console.log(`  ${"nomination_vote_yes:".padEnd(36)} ${counts.nomination_vote_yes}`);
    console.log(`  ${"nomination_vote_no:".padEnd(36)} ${counts.nomination_vote_no}`);
    console.log(`  ${"oversight:".padEnd(36)} ${counts.oversight}`);
    console.log(`  ${"appointment:".padEnd(36)} ${counts.appointment}`);
    console.log(`  ${"failed:".padEnd(36)} ${counts.failed}`);

    const { data: sample } = await db
      .from("entity_connections")
      .select("from_type, from_id, to_type, to_id, connection_type, strength")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sample) {
      console.log("\n  Sample connection (most recent):");
      console.log(
        `    ${sample.from_type}(${String(sample.from_id).slice(0, 8)}…) → ${sample.connection_type} → ${sample.to_type}(${String(sample.to_id).slice(0, 8)}…)  [strength: ${sample.strength}]`
      );
    }

    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Connections pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted: 0, updated: 0, failed: counts.failed + 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      await runConnectionsPipeline();
      process.exit(0);
    } catch (err) {
      console.error("Fatal:", err);
      process.exit(1);
    }
  })();
}
