/**
 * FIX-940 — move Senate votes off FEC candidate stubs onto the sitting Senator.
 *
 * WHAT WENT WRONG
 * ---------------
 * `buildOfficialMaps` in ../pipelines/congress/votes.ts resolved a Senate roll-
 * call member by `lastname:state` against EVERY official in the Senate governing
 * body — 2,054 rows on the 2026-07-30 clone, of which 1,953 are `tier='candidate'`
 * stubs minted by the FEC cn{yy} stage (FIX-246) — ordered by uuid, with an
 * unconditional `.set()`. Roughly half of contested slots resolved to the stub,
 * so every subsequent roll-call for those members landed on a row nobody can
 * see. Measured on the clone: 1,755 votes across 49 candidate-tier officials,
 * 2026-05-11 → 2026-07-23. Jon Ossoff's elected row stops at 2026-05-20; his
 * stub runs 2026-06-01 → 2026-07-23. Nothing errored — the insert succeeded.
 *
 * THE WRITER FIX MUST LAND FIRST
 * ------------------------------
 * `votes` is unique on `(roll_call_id, official_id)`, so moving the rows while
 * the map is still broken just gets them re-split by the next nightly. On prod
 * that ordering is: code lands → deployed → THEN this script. Running it against
 * an environment whose pipeline still carries the old map is wasted I/O at best.
 *
 * WHAT IT DOES
 * ------------
 * Per candidate-tier official holding Senate votes, find the elected, active
 * same-surname member of the SAME governing body and jurisdiction, pre-delete
 * any `(roll_call_id, official_id)` row that would collide (keeping the ELECTED
 * row's copy — it was written under the correct binding), then rewrite
 * `votes.official_id` to the twin. Ids are derived by join; nothing is hardcoded.
 * Idempotent: a second run finds no stub still holding votes and reports zero.
 *
 * THE DIACRITIC CASE IS HELD BACK BY DEFAULT
 * ------------------------------------------
 * 48 of the 49 stubs have an EXACT same-surname elected twin. The 49th does not:
 * "Ben Lujan" (NM, 72 votes) vs the sitting "Ben Ray Luján" (bioguide L000570) —
 * the surnames differ only by the accent, because the Senate XML spells every
 * name ASCII-only. That match is only visible once diacritics are folded, so it
 * is REPORTED and skipped unless `--include-diacritic-matches` is passed. The
 * writer fix folds diacritics on both sides, so his votes bind correctly from
 * the next run onward regardless of what this script does with the backlog.
 *
 * VOTE STATS ARE REBUILT EXPLICITLY
 * ---------------------------------
 * `official_vote_stats` is materialized off `votes` (FIX-837), so until it is
 * rebuilt the affected Senators' bipartisan and attendance figures stay
 * understated. The nightly `vote-stats-refresh` (03:30 UTC) would heal it, but
 * this script CALLs `rebuild_official_vote_stats()` itself rather than leaving
 * the DB in a knowingly-wrong state. `entity_connections` vote edges are NOT
 * rebuilt here — they are a display cache owned by the Sun+Wed rebuild cron,
 * which TRUNCATEs and re-derives from `votes`; the stale-edge count is reported
 * so the lag is legible rather than silent.
 *
 * Usage:
 *   pnpm --filter @civitics/data data:move-stub-senate-votes                    # dry-run (ROLLBACK)
 *   pnpm --filter @civitics/data data:move-stub-senate-votes -- --apply         # commit
 *   pnpm --filter @civitics/data data:move-stub-senate-votes -- --apply --include-diacritic-matches
 */

import { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { callHeavyProcedure } from "../lib/heavy-rebuild";
import { normalizeSurname } from "../pipelines/congress/votes-maps";

/** Sanity bound — the clone measured 49 stubs. A wildly larger set means the
 *  query drifted, not that the problem grew; refuse rather than mass-rewrite. */
const MAX_STUBS = 300;

interface StubRow {
  stub_id:          string;
  stub_name:        string;
  stub_last_name:   string | null;
  jurisdiction_id:  string | null;
  governing_body_id: string | null;
  state:            string | null;
  votes:            number;
  min_d:            string | null;
  max_d:            string | null;
}

interface ElectedRow {
  id:                string;
  full_name:         string;
  last_name:         string | null;
  jurisdiction_id:   string | null;
  governing_body_id: string | null;
  bioguide:          string | null;
  votes:             number;
  max_d:             string | null;
}

type MatchKind = "exact" | "diacritic";

interface Pair {
  stub:  StubRow;
  twin:  ElectedRow;
  kind:  MatchKind;
}

function envLabel(): "local" | "prod" {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  return /127\.0\.0\.1|localhost/.test(url) ? "local" : "prod";
}

async function run(
  client: Client,
  label: string,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const res = await client.query(sql, params);
  const n = res.rowCount ?? 0;
  console.log(`  ${label.padEnd(56)} ${String(n).padStart(7)}`);
  return n;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const allowProd = argv.includes("--allow-prod");
  const includeDiacritic = argv.includes("--include-diacritic-matches");
  const prod = envLabel() === "prod";

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  This script REWRITES votes.official_id. The writer fix (FIX-940) must be\n" +
        "  deployed to prod BEFORE this runs, or the next nightly re-splits the rows.",
    );
    process.exit(1);
  }

  const dbUrl = buildDbUrl();
  console.log("# FIX-940 — move Senate votes off candidate stubs");
  console.log(`Env:        ${envLabel()}`);
  console.log(`Connection: ${dbUrl.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`Mode:       ${apply ? "APPLY (COMMIT)" : "DRY-RUN (ROLLBACK)"}`);
  console.log(`Diacritic-only matches: ${includeDiacritic ? "INCLUDED" : "held back (report only)"}\n`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  if (!prod) await client.query("SET max_parallel_workers_per_gather = 0");

  try {
    await client.query("BEGIN");

    // ── 1. Candidate-tier officials holding votes ──────────────────────────
    const stubs = (
      await client.query<StubRow>(`
        SELECT o.id                AS stub_id,
               o.full_name         AS stub_name,
               o.last_name         AS stub_last_name,
               o.jurisdiction_id,
               o.governing_body_id,
               j.short_name        AS state,
               count(v.id)::int    AS votes,
               min(v.voted_at)::date::text AS min_d,
               max(v.voted_at)::date::text AS max_d
          FROM public.officials o
          JOIN public.votes v ON v.official_id = o.id
          LEFT JOIN public.jurisdictions j ON j.id = o.jurisdiction_id
         WHERE o.tier = 'candidate'
         GROUP BY 1,2,3,4,5,6
         ORDER BY votes DESC
      `)
    ).rows;

    const totalVotes = stubs.reduce((a, s) => a + s.votes, 0);
    console.log(`Candidate-tier officials holding votes: ${stubs.length} (${totalVotes} votes)\n`);

    if (stubs.length === 0) {
      console.log("Nothing to move. (Expected on a re-run after --apply.)");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }
    if (stubs.length > MAX_STUBS) {
      throw new Error(
        `refusing to act: ${stubs.length} stubs exceeds the ${MAX_STUBS} sanity bound`,
      );
    }

    // ── 2. Resolve each stub's elected twin ────────────────────────────────
    // Surname folding is done in JS with the SAME helper the writer keys on, so
    // the two can never diverge on what "same surname" means.
    const bodyIds = [...new Set(stubs.map((s) => s.governing_body_id).filter(Boolean))] as string[];
    const elected = (
      await client.query<ElectedRow>(
        `SELECT o.id, o.full_name, o.last_name, o.jurisdiction_id, o.governing_body_id,
                o.source_ids->>'congress_gov' AS bioguide,
                count(v.id)::int AS votes,
                max(v.voted_at)::date::text AS max_d
           FROM public.officials o
           LEFT JOIN public.votes v ON v.official_id = o.id
          WHERE o.tier = 'elected' AND o.is_active
            AND o.governing_body_id = ANY($1::uuid[])
          GROUP BY 1,2,3,4,5,6`,
        [bodyIds],
      )
    ).rows;

    /** (governing_body, jurisdiction, folded surname) → elected rows */
    const byKey = new Map<string, ElectedRow[]>();
    for (const e of elected) {
      const k = `${e.governing_body_id}|${e.jurisdiction_id}|${normalizeSurname(e.last_name)}`;
      byKey.set(k, [...(byKey.get(k) ?? []), e]);
    }

    const pairs: Pair[] = [];
    const unresolved: Array<{ stub: StubRow; why: string }> = [];

    for (const s of stubs) {
      const folded = normalizeSurname(s.stub_last_name);
      if (!folded) {
        unresolved.push({ stub: s, why: "stub has no last_name" });
        continue;
      }
      const cands = byKey.get(`${s.governing_body_id}|${s.jurisdiction_id}|${folded}`) ?? [];
      if (cands.length === 0) {
        unresolved.push({ stub: s, why: "no elected same-surname member in this body + jurisdiction" });
        continue;
      }
      if (cands.length > 1) {
        // Ambiguous — refuse, exactly as the writer's map does. Never guess.
        unresolved.push({
          stub: s,
          why: `${cands.length} elected same-surname members (${cands.map((c) => c.id).join(", ")})`,
        });
        continue;
      }
      const twin = cands[0]!;
      const kind: MatchKind =
        (s.stub_last_name ?? "").trim().toLowerCase() === (twin.last_name ?? "").trim().toLowerCase()
          ? "exact"
          : "diacritic";
      pairs.push({ stub: s, twin, kind });
    }

    // ── 3. Report the plan ─────────────────────────────────────────────────
    const actionable = pairs.filter((p) => p.kind === "exact" || includeDiacritic);
    const heldBack   = pairs.filter((p) => p.kind === "diacritic" && !includeDiacritic);

    console.log("── Plan ─────────────────────────────────────────────────────");
    for (const p of actionable) {
      console.log(
        `  ${(p.stub.stub_name + " (" + (p.stub.state ?? "??") + ")").padEnd(30)} ` +
          `${String(p.stub.votes).padStart(5)} votes  ${p.stub.min_d}→${p.stub.max_d}  ` +
          `→ ${p.twin.full_name}${p.kind === "diacritic" ? "  [diacritic-only match]" : ""}`,
      );
    }
    console.log(
      `\n  ${actionable.length} stub(s) actionable, ` +
        `${actionable.reduce((a, p) => a + p.stub.votes, 0)} votes to move.`,
    );

    for (const p of heldBack) {
      console.warn(
        `\n  ⚠ HELD BACK (diacritic-only surname match — pass --include-diacritic-matches to move):\n` +
          `      stub  ${p.stub.stub_id}  "${p.stub.stub_name}" last_name="${p.stub.stub_last_name}" ` +
          `(${p.stub.state ?? "??"})  ${p.stub.votes} votes ${p.stub.min_d}→${p.stub.max_d}\n` +
          `      twin  ${p.twin.id}  "${p.twin.full_name}" last_name="${p.twin.last_name}" ` +
          `bioguide=${p.twin.bioguide ?? "(none)"}  currently ${p.twin.votes} votes ` +
          `(max ${p.twin.max_d ?? "n/a"})`,
      );
    }
    for (const u of unresolved) {
      console.warn(
        `\n  ⚠ NO TWIN — taking no action:\n` +
          `      stub  ${u.stub.stub_id}  "${u.stub.stub_name}" (${u.stub.state ?? "??"})  ` +
          `${u.stub.votes} votes ${u.stub.min_d}→${u.stub.max_d}\n` +
          `      reason: ${u.why}`,
      );
    }

    if (actionable.length === 0) {
      console.log("\nNothing actionable.");
      await client.query("ROLLBACK");
      await client.end();
      return;
    }

    // ── 4. Baseline: every official's vote count, to prove nothing else moved ─
    await client.query(`
      CREATE TEMP TABLE _before ON COMMIT DROP AS
        SELECT official_id, count(*)::bigint AS n FROM public.votes GROUP BY 1
    `);

    const stubIds = actionable.map((p) => p.stub.stub_id);
    const twinIds = actionable.map((p) => p.twin.id);

    // ── 5. Pre-delete collisions, keeping the ELECTED row's vote ───────────
    // Both rows holding the same roll_call_id would violate the
    // (roll_call_id, official_id) unique index on UPDATE. The elected row's copy
    // was written under the correct binding, so the stub's is the one dropped.
    // Expect ~0 given the clean date split, but a re-run or a partially-repaired
    // env can produce them, so the step is mandatory rather than opportunistic.
    console.log("\n── Rewrite ──────────────────────────────────────────────────");
    let deleted = 0;
    let moved = 0;
    for (const p of actionable) {
      deleted += await run(
        client,
        `del collisions  ${p.stub.stub_name.slice(0, 24)}`,
        `DELETE FROM public.votes vs
           WHERE vs.official_id = $1
             AND EXISTS (SELECT 1 FROM public.votes ve
                          WHERE ve.official_id = $2
                            AND ve.roll_call_id IS NOT DISTINCT FROM vs.roll_call_id)`,
        [p.stub.stub_id, p.twin.id],
      );
      moved += await run(
        client,
        `move votes      ${p.stub.stub_name.slice(0, 24)} → ${p.twin.full_name.slice(0, 20)}`,
        `UPDATE public.votes SET official_id = $2 WHERE official_id = $1`,
        [p.stub.stub_id, p.twin.id],
      );
    }
    console.log(`\n  ${moved} votes moved, ${deleted} colliding stub row(s) deleted.`);

    // ── 6. Conservation proof ──────────────────────────────────────────────
    console.log("\n── Verification ─────────────────────────────────────────────");

    const stray = (
      await client.query<{ n: string; ids: string }>(
        `SELECT count(*)::text AS n, coalesce(string_agg(DISTINCT v.official_id::text, ', '), '') AS ids
           FROM public.votes v JOIN public.officials o ON o.id = v.official_id
          WHERE o.tier = 'candidate'`,
      )
    ).rows[0]!;
    const heldBackVotes = heldBack.reduce((a, p) => a + p.stub.votes, 0)
      + unresolved.reduce((a, u) => a + u.stub.votes, 0);
    const strayOk = Number(stray.n) === heldBackVotes;
    console.log(
      `  votes still on tier='candidate' officials: ${stray.n} ` +
        `(expected ${heldBackVotes} — the held-back/no-twin stubs)  ${strayOk ? "✓" : "✗"}`,
    );

    // Nobody outside {stubs ∪ twins} may have changed. This is the stop
    // condition: a count moving on an unrelated official means the twin
    // resolution bound the wrong row.
    const collateral = (
      await client.query<{ official_id: string; before: string; after: string }>(
        `WITH after AS (SELECT official_id, count(*)::bigint AS n FROM public.votes GROUP BY 1)
         SELECT coalesce(b.official_id, a.official_id)::text AS official_id,
                coalesce(b.n, 0)::text AS before, coalesce(a.n, 0)::text AS after
           FROM _before b FULL OUTER JOIN after a ON a.official_id = b.official_id
          WHERE coalesce(b.n, 0) <> coalesce(a.n, 0)
            AND NOT (coalesce(b.official_id, a.official_id) = ANY($1::uuid[]))
            AND NOT (coalesce(b.official_id, a.official_id) = ANY($2::uuid[]))`,
        [stubIds, twinIds],
      )
    ).rows;
    const collateralOk = collateral.length === 0;
    console.log(
      `  officials outside the move whose count changed: ${collateral.length}  ${collateralOk ? "✓" : "✗"}`,
    );
    for (const c of collateral) {
      console.error(`      ${c.official_id}  ${c.before} → ${c.after}`);
    }

    const totalBeforeAfter = (
      await client.query<{ before: string; after: string }>(
        `SELECT (SELECT coalesce(sum(n), 0)::text FROM _before) AS before,
                (SELECT count(*)::text FROM public.votes)        AS after`,
      )
    ).rows[0]!;
    console.log(
      `  total votes: ${totalBeforeAfter.before} → ${totalBeforeAfter.after} ` +
        `(delta ${Number(totalBeforeAfter.after) - Number(totalBeforeAfter.before)}, ` +
        `expected -${deleted})`,
    );
    const totalOk =
      Number(totalBeforeAfter.before) - Number(totalBeforeAfter.after) === deleted;
    console.log(`  total conserved minus pre-deleted collisions: ${totalOk ? "✓" : "✗"}`);

    // Per-twin before/after, the number a human actually checks.
    const twinAfter = (
      await client.query<{ id: string; full_name: string; n: string; max_d: string | null }>(
        `SELECT o.id::text, o.full_name, count(v.id)::text AS n, max(v.voted_at)::date::text AS max_d
           FROM public.officials o LEFT JOIN public.votes v ON v.official_id = o.id
          WHERE o.id = ANY($1::uuid[])
          GROUP BY 1,2 ORDER BY o.full_name`,
        [twinIds],
      )
    ).rows;
    console.log("\n  Elected rows after the move:");
    for (const t of twinAfter) {
      const before = actionable.find((p) => p.twin.id === t.id)?.twin;
      console.log(
        `      ${t.full_name.padEnd(26)} ${String(before?.votes ?? "?").padStart(5)} → ` +
          `${t.n.padStart(5)} votes   max ${before?.max_d ?? "n/a"} → ${t.max_d ?? "n/a"}`,
      );
    }

    if (!strayOk || !collateralOk || !totalOk) {
      throw new Error("verification FAILED — rolling back (see report above)");
    }

    if (apply) {
      await client.query("ANALYZE public.votes");
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED — ${moved} votes moved across ${actionable.length} officials.`);
    } else {
      await client.query("ROLLBACK");
      console.log("\n✓ DRY-RUN complete — all checks passed, rolled back. Re-run with --apply to commit.");
      await client.end();
      return;
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n✗ Rolled back due to error:", err instanceof Error ? err.message : String(err));
    await client.end();
    process.exit(1);
  }

  // ── 7. Post-commit: stale display caches ─────────────────────────────────
  const staleEdges = (
    await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.entity_connections ec
         JOIN public.officials o ON o.id = ec.from_id AND ec.from_type = 'official'
        WHERE o.tier = 'candidate' AND ec.connection_type IN ('vote_yes', 'vote_no')`,
    )
  ).rows[0]!;
  await client.end();

  console.log("\n── Derived state ────────────────────────────────────────────");
  console.log(
    `  entity_connections vote edges still on candidate stubs: ${staleEdges.n}\n` +
      `      Not rebuilt here — entity_connections is a display cache owned by the\n` +
      `      Sun+Wed rebuild cron, which TRUNCATEs and re-derives from votes (FIX-735).`,
  );

  console.log("  Rebuilding official_vote_stats (materialized off votes, FIX-837) ...");
  const t0 = Date.now();
  await callHeavyProcedure("rebuild_official_vote_stats");
  console.log(`  ✓ official_vote_stats rebuilt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("[move-stub-senate-votes] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
