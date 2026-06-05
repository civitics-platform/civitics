/**
 * Legistar pipeline — city council legislation for pilot metros.
 *
 * Metros: Seattle (seattle), San Francisco (sfgov), Austin (austintexas).
 *   NYC (slug 'nyc') requires an API token and is skipped.
 *   DC uses a separate DC LIMS adapter (dc-lims/), not Legistar.
 *
 * Per-metro flow:
 *   1. Bodies         → governing_bodies (+ external_source_refs)
 *   2. Persons        → officials        (+ external_source_refs)
 *   3. Matters        → proposals + bill_details (+ external_source_refs)
 *   4. Events         → meetings         (+ external_source_refs)
 *   5. EventItems     → agenda_items     (per-event, batched within event)
 *   6. Votes          → votes            (per-event, batched within event)
 *
 * Delta cursor: `legistar_{client}_last_run` in pipeline_state — used as
 * `since` on Matters (MatterLastModifiedUtc) and Events (EventDate).
 *
 * Runtime is dominated by per-event API fetches (eventitems + votes). DB
 * writes are batched so they don't add any measurable overhead on top.
 *
 * Run:
 *   pnpm --filter @civitics/data data:legistar              (all metros)
 *   pnpm --filter @civitics/data data:legistar -- --metro seattle
 *   pnpm --filter @civitics/data data:legistar -- --force   (skip recency guard)
 */

import { createAdminClient } from "@civitics/db";
import { sleep } from "../utils";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { slugifyGoverningBodies } from "../../lib/slugify-governing-bodies";
import { seedPilotMetros } from "../../jurisdictions/pilot-metros";
import { LegistarClient } from "./client";
import type { LegistarEventItem, MetroConfig } from "./types";
import {
  upsertBodiesBatch,
  upsertPersonsBatch,
  upsertMattersBatch,
  upsertEventsBatch,
  upsertEventItemsBatch,
  upsertVotesBatch,
  type VoteBatchInput,
} from "./writer";

// ---------------------------------------------------------------------------
// Metro registry (jurisdictionId populated at startup from seedPilotMetros)
// ---------------------------------------------------------------------------

// `client` is the Legistar API client name (feeds the API URL, the
// `legistar_${client}_last_run` cursor, source_url, and metadata.legistar_client
// — never rewrite it). `slug` is the display slug embedded in the xsr source
// string and rendered by resolveSource (`legistar:${slug}` → "Legistar <Slug>").
// Decoupled in FIX-411 so ugly API client names ('sfgov', 'austintexas') don't
// leak into user-visible source labels. Seattle's slug already equals its client.
const METRO_CLIENTS: Array<{ client: string; name: string; slug: string }> = [
  { client: "seattle",     name: "Seattle",       slug: "seattle"       },
  { client: "sfgov",       name: "San Francisco", slug: "san-francisco" },
  { client: "austintexas", name: "Austin",        slug: "austin"        },
];

// How far back to fetch events on first run (days).
const FIRST_RUN_EVENT_LOOKBACK_DAYS = 90;

type Db = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// Per-metro orchestrator
// ---------------------------------------------------------------------------

async function runMetro(
  db: Db,
  config: MetroConfig,
  force: boolean,
): Promise<{
  matters: number;
  meetings: number;
  agendaItems: number;
  votes: number;
  officials: number;
  bodies: number;
}> {
  console.log(`\n  ── ${config.name} (${config.client}) ──────────────────────────`);

  const stateKey = `legistar_${config.client}_last_run`;
  const { data: stateRow } = await db
    .from("pipeline_state")
    .select("value")
    .eq("key", stateKey)
    .maybeSingle();

  const lastRun = (stateRow?.value as Record<string, unknown> | null)?.last_run as string | undefined;
  const hoursSince = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 3_600_000 : Infinity;

  if (!force && hoursSince < 6) {
    console.log(`    Skipping — ran ${hoursSince.toFixed(1)}h ago (min 6h). Use --force to override.`);
    return { matters: 0, meetings: 0, agendaItems: 0, votes: 0, officials: 0, bodies: 0 };
  }

  const api = new LegistarClient(config.client);

  // ── Step 1: Bodies ───────────────────────────────────────────────────────
  const bodies = await api.fetchBodies();
  console.log(`    Bodies: ${bodies.length} fetched`);
  const bodyRes = await upsertBodiesBatch(db, bodies, config);
  console.log(`    Bodies: ${bodyRes.bodyIdMap.size} upserted (${bodyRes.inserted} new)`);

  // ── Step 2: Persons ─────────────────────────────────────────────────────
  const persons = await api.fetchPersons();
  console.log(`    Persons: ${persons.length} fetched`);
  // Resolve a primary council body for officials.governing_body_id (NOT NULL).
  // Prefer municipal_council; fall back to the first body we know about.
  const { data: councilBody } = await db
    .from("governing_bodies")
    .select("id")
    .eq("jurisdiction_id", config.jurisdictionId)
    .eq("type", "municipal_council")
    .limit(1)
    .maybeSingle();
  const primaryBodyId: string | null =
    councilBody?.id
      ?? (bodyRes.bodyIdMap.size > 0 ? [...bodyRes.bodyIdMap.values()][0] : null);

  let personRes: Awaited<ReturnType<typeof upsertPersonsBatch>> = {
    personIdMap: new Map(),
    inserted: 0,
    failed: 0,
  };
  if (!primaryBodyId) {
    console.warn(`    Persons: no governing body for ${config.name} — skipping persons`);
  } else {
    personRes = await upsertPersonsBatch(db, persons, config, primaryBodyId);
    console.log(`    Persons: ${personRes.personIdMap.size} upserted (${personRes.inserted} new)`);
  }

  // ── Step 3: Matters ──────────────────────────────────────────────────────
  const matters = await api.fetchMatters(lastRun);
  console.log(`    Matters: ${matters.length} fetched`);
  const matterRes = await upsertMattersBatch(db, matters, config, bodyRes.bodyIdMap);
  console.log(`    Matters: ${matterRes.matterIdMap.size} upserted (${matterRes.inserted} new, ${matterRes.updated} updated)`);

  // ── Step 4: Events ───────────────────────────────────────────────────────
  const eventSince = lastRun ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - FIRST_RUN_EVENT_LOOKBACK_DAYS);
    return d.toISOString().slice(0, 19);
  })();
  const events = await api.fetchEvents(eventSince);
  console.log(`    Events: ${events.length} fetched (since ${eventSince.slice(0, 10)})`);
  const eventRes = await upsertEventsBatch(db, events, config, bodyRes.bodyIdMap);
  console.log(`    Events: ${eventRes.eventIdMap.size} upserted (${eventRes.inserted} new)`);

  // ── Steps 5+6: EventItems + Votes (per-event fetch + batch write) ────────
  let totalItems = 0;
  let totalVotes = 0;
  const eventIds = [...eventRes.eventIdMap.keys()];
  console.log(`    EventItems+Votes: fetching for ${eventIds.length} meetings...`);

  for (let i = 0; i < eventIds.length; i++) {
    const legiEventId = eventIds[i];
    const meetingId = eventRes.eventIdMap.get(legiEventId)!;

    let items: LegistarEventItem[];
    try {
      items = await api.fetchEventItems(legiEventId);
    } catch (err) {
      console.warn(`      Event ${legiEventId}: fetchEventItems failed — ${(err as Error).message}`);
      continue;
    }
    if (items.length === 0) continue;

    const itemRes = await upsertEventItemsBatch(
      db, items, meetingId, matterRes.matterIdMap, config,
    );
    totalItems += itemRes.inserted;

    // For each roll-call item with a resolved proposal, fetch votes and
    // accumulate into a per-event batch. One upsert call per event.
    const voteInputs: VoteBatchInput[] = [];
    for (const item of items) {
      if (item.EventItemRollCallFlag !== 1) continue;
      const billProposalId = item.EventItemMatterId
        ? matterRes.matterIdMap.get(item.EventItemMatterId) ?? null
        : null;
      if (!billProposalId) continue;

      const agendaItemId = itemRes.eventItemIdMap.get(item.EventItemId) ?? null;

      let legiVotes;
      try {
        legiVotes = await api.fetchVotes(item.EventItemId);
      } catch {
        continue; // non-fatal — per-item rate limits can transient-fail
      }

      for (const legiVote of legiVotes) {
        const officialId = personRes.personIdMap.get(legiVote.VotePersonId);
        if (!officialId) continue;
        voteInputs.push({
          legiVote,
          billProposalId,
          officialId,
          votedAt: new Date().toISOString(), // no per-vote timestamp from Legistar; event date is a better approx for nightly runs
          agendaItemId,
        });
      }
      await sleep(100); // per-event-item rate limit on votes endpoint
    }

    if (voteInputs.length > 0) {
      const voteRes = await upsertVotesBatch(db, voteInputs, config);
      totalVotes += voteRes.upserted;
    }

    if ((i + 1) % 20 === 0) {
      console.log(`    EventItems: ${i + 1}/${eventIds.length} meetings processed (${totalItems} items, ${totalVotes} votes)`);
    }
    await sleep(150); // per-event rate limit
  }

  // ── Persist cursor ───────────────────────────────────────────────────────
  await db.from("pipeline_state").upsert(
    {
      key: stateKey,
      value: {
        last_run: new Date().toISOString(),
        matters: matterRes.matterIdMap.size,
        meetings: eventRes.eventIdMap.size,
      },
    },
    { onConflict: "key" },
  );

  return {
    matters: matterRes.matterIdMap.size,
    meetings: eventRes.eventIdMap.size,
    agendaItems: totalItems,
    votes: totalVotes,
    officials: personRes.personIdMap.size,
    bodies: bodyRes.bodyIdMap.size,
  };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runLegistarPipeline(): Promise<PipelineResult> {
  console.log("\n=== Legistar city council pipeline (public) ===");
  const db = createAdminClient();
  const force = process.argv.includes("--force");
  const metroArg = (() => {
    const idx = process.argv.indexOf("--metro");
    return idx !== -1 ? (process.argv[idx + 1] ?? null) : null;
  })();

  const logId = await startSync("legistar");

  try {
    console.log("\n  Resolving pilot metro jurisdictions...");
    const jurisdictionMap = await seedPilotMetros(db);

    const metros: MetroConfig[] = METRO_CLIENTS
      .filter((m) => !metroArg || m.client === metroArg)
      .map((m) => {
        const jid = jurisdictionMap.get(m.client);
        if (!jid) console.warn(`  ⚠  ${m.name}: jurisdiction not found — skipping`);
        return jid ? { ...m, source: `legistar:${m.slug}`, jurisdictionId: jid } : null;
      })
      .filter((m): m is MetroConfig => m !== null);

    if (metros.length === 0) {
      console.error("  No metros configured — did data:pilot-metros run?");
      await failSync(logId, "no metros with jurisdiction IDs");
      return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
    }

    let totalBodies = 0;
    let totalOfficials = 0;
    let totalMatters = 0;
    let totalMeetings = 0;
    let totalItems = 0;
    let totalVotes = 0;
    const failures: string[] = [];

    for (const config of metros) {
      try {
        const r = await runMetro(db, config, force);
        totalBodies += r.bodies;
        totalOfficials += r.officials;
        totalMatters += r.matters;
        totalMeetings += r.meetings;
        totalItems += r.agendaItems;
        totalVotes += r.votes;
      } catch (err) {
        const msg = `${config.name}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`  ✗  ${msg}`);
        failures.push(msg);
      }
    }

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  Legistar pipeline report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"governing_bodies:".padEnd(36)} ${totalBodies}`);
    console.log(`  ${"officials (persons):".padEnd(36)} ${totalOfficials}`);
    console.log(`  ${"proposals (matters):".padEnd(36)} ${totalMatters}`);
    console.log(`  ${"meetings (events):".padEnd(36)} ${totalMeetings}`);
    console.log(`  ${"agenda items:".padEnd(36)} ${totalItems}`);
    console.log(`  ${"votes:".padEnd(36)} ${totalVotes}`);
    if (failures.length > 0) {
      console.log(`  ${"metro failures:".padEnd(36)} ${failures.join("; ")}`);
    }

    const result: PipelineResult = {
      inserted: totalMatters + totalMeetings + totalItems + totalVotes,
      updated: 0,
      failed: failures.length,
      estimatedMb: 0,
    };
    // FIX-492 — slugify ingest invariant: municipal-council gbs created by the
    // Legistar writer get their slug filled (needed for /institutions URLs even
    // though city gbs are outside the graph-expansion allowlist). Idempotent.
    await slugifyGoverningBodies(db);
    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Legistar pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runLegistarPipeline()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
