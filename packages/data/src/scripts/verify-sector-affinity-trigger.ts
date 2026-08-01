/**
 * FIX-958 / FIX-959 / FIX-923 — verification harness for the sector-affinity
 * tag-change trigger. Runs the four required proofs against the ACTIVE env:
 *
 *   A. NO-OP    — the tagger's DELETE-then-reinsert of identical content
 *                 produces an identical signature and ZERO rollup work on the
 *                 second run (the decision-1 always-fires trap, disproven).
 *   B. TARGETED — flipping ONE donor's industry via the override table rebuilds
 *                 exactly that donor's recipients, not the 19,869-official
 *                 backfill population.
 *   C. LAG      — after ONE runRuleBasedTagger() (the real nightly order:
 *                 financialEntities → refresh → officials), the receiving
 *                 official's industry pill already reflects the flip. One run,
 *                 not two (FIX-959 decision 4).
 *   D. ALARM    — check_sector_affinity_tag_staleness() stays quiet on a no-op
 *                 night, reports 'pending' on a fresh mismatch, and escalates
 *                 stale=true only once the mismatch has been outstanding >26h
 *                 (synthesized by backdating the probe).
 *
 * Plus: rollup conservation against the LIVE ledger (never against another
 * materialization — the 2026-07-29 $107.9M phantom-loss lesson, b3c47dd4), and
 * the FIX-923-tightened zero-out-of-vocabulary assertion in re-runnable form.
 *
 * LOCAL ONLY. Proofs B/C mutate financial_entity_industry_overrides (a probe
 * row, removed and restored before exit) and re-run the tagger; there is no
 * --allow-prod escape hatch on purpose.
 *
 * Run: pnpm --filter @civitics/data data:verify:sector-affinity
 * Expect ~30-45 min on local Docker (two full tagger runs + one cold-start
 * backfill if the signature store is empty).
 */

import { Client } from "pg";
import { createAdminClient } from "@civitics/db";
import { runRuleBasedTagger, tagFinancialEntities, tagOfficials } from "../pipelines/tags/rules";
import { callHeavyProcedure } from "../lib/heavy-rebuild";

const SIG_KEY   = "sector_affinity:industry_tag_signature";
const PROBE_KEY = "sector_affinity:staleness_probe";
const PROBE_SOURCE = "verify-fix958-lag-probe";

let failures = 0;

function assert(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

type RefreshRow = {
  status: string;
  path: string | null;
  sig: string | null;
  donors_changed: number | null;
  officials_affected: number | null;
  rows_inserted: number | null;
};

async function lastRefreshRow(pg: Client): Promise<RefreshRow> {
  const r = await pg.query(
    `SELECT status,
            metadata->>'path'                        AS path,
            COALESCE(metadata->>'sig', metadata->>'sig_after') AS sig,
            (metadata->>'donors_changed')::int       AS donors_changed,
            (metadata->>'officials_affected')::int   AS officials_affected,
            rows_inserted::int                       AS rows_inserted
       FROM public.data_sync_log
      WHERE pipeline = 'sector_affinity_tag_refresh'
      ORDER BY started_at DESC
      LIMIT 1`,
  );
  return r.rows[0] as RefreshRow;
}

async function conservation(pg: Client): Promise<void> {
  // Against the LIVE ledger, never another materialization (b3c47dd4).
  const r = await pg.query(
    `SELECT (SELECT COALESCE(SUM(amount_cents), 0)
               FROM public.financial_relationships
              WHERE relationship_type = 'donation'
                AND from_type = 'financial_entity'
                AND to_type   = 'official'
                AND amount_cents > 0)::text AS ledger,
            (SELECT COALESCE(SUM(total_cents), 0)
               FROM public.official_sector_affinity_rollup)::text AS rollup`,
  );
  const { ledger, rollup } = r.rows[0] as { ledger: string; rollup: string };
  assert(ledger === rollup, `conservation: rollup SUM == live ledger SUM`,
    `ledger=${ledger} rollup=${rollup}`);
}

async function main(): Promise<void> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  if (!supabaseUrl.includes("127.0.0.1") && !supabaseUrl.includes("localhost")) {
    throw new Error(
      `verify-sector-affinity-trigger is LOCAL ONLY (active env: ${supabaseUrl || "unset"}). ` +
        `It mutates the override table and re-runs the tagger.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const pg = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    application_name: "verify_sector_affinity_trigger",
  });
  await pg.connect();

  try {
    // ── Proof A: no-op — identical content → identical signature, zero work ──
    console.log("\n=== Proof A — no-op (run the tagger's donor phase twice, no tag change) ===");
    await tagFinancialEntities(db);
    await callHeavyProcedure("refresh_sector_affinity_from_tag_changes");
    const a1 = await lastRefreshRow(pg);
    console.log(`  run 1: path=${a1.path} sig=${a1.sig}`);

    await tagFinancialEntities(db);
    await callHeavyProcedure("refresh_sector_affinity_from_tag_changes");
    const a2 = await lastRefreshRow(pg);
    console.log(`  run 2: path=${a2.path} sig=${a2.sig}`);

    assert(a2.path === "noop", "A: second run is a no-op", `path=${a2.path}`);
    assert(a2.sig !== null && a2.sig === a1.sig, "A: signatures identical across runs",
      `sig1=${a1.sig} sig2=${a2.sig}`);
    assert((a2.rows_inserted ?? -1) === 0, "A: zero rollup rows written on the no-op run",
      `rows=${a2.rows_inserted}`);
    await conservation(pg);

    // ── Pick the probe pair for B/C ──────────────────────────────────────────
    // A rollup sector at rank<=3 for an ACTIVE official whose dollars come from
    // exactly ONE donor with an fec_committee_id and no existing override, and
    // a target industry absent from that official's rollup — so the flip moves
    // the sector's exact cents to a new pill deterministically.
    const probe = await pg.query(
      `WITH ranked AS (
         SELECT r.official_id, r.industry, r.total_cents, r.donor_count,
                row_number() OVER (PARTITION BY r.official_id
                                   ORDER BY r.total_cents DESC, r.industry) AS rank
           FROM public.official_sector_affinity_rollup r
           JOIN public.officials o ON o.id = r.official_id
          WHERE o.is_active AND r.industry <> 'Untagged' AND r.total_cents > 0
       ),
       candidates AS (
         SELECT rk.official_id, rk.industry, rk.total_cents, rk.rank,
                fr.from_id AS donor_id
           FROM ranked rk
           JOIN public.financial_relationships fr
             ON fr.to_id = rk.official_id
            AND fr.relationship_type = 'donation'
            AND fr.from_type = 'financial_entity'
            AND fr.to_type   = 'official'
            AND fr.amount_cents > 0
           JOIN public.entity_tags et
             ON et.entity_id = fr.from_id
            AND et.entity_type = 'financial_entity'
            AND et.tag_category = 'industry'
          WHERE rk.rank <= 3 AND rk.donor_count = 1
          GROUP BY rk.official_id, rk.industry, rk.total_cents, rk.rank, fr.from_id
         HAVING min(et.tag) = rk.industry
       )
       SELECT c.official_id, c.industry AS old_industry, c.total_cents, c.rank,
              c.donor_id, fe.fec_committee_id, fe.display_name,
              (SELECT t FROM unnest(ARRAY['health','finance','tech','labor','retail',
                                          'defense','agriculture','legal','media',
                                          'utilities','manufacturing','mining']) AS t
                WHERE t <> c.industry
                  AND NOT EXISTS (SELECT 1 FROM public.official_sector_affinity_rollup r2
                                   WHERE r2.official_id = c.official_id AND r2.industry = t)
                LIMIT 1) AS new_industry
         FROM candidates c
         JOIN public.financial_entities fe ON fe.id = c.donor_id
        WHERE fe.fec_committee_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.financial_entity_industry_overrides o
                           WHERE o.fec_committee_id = fe.fec_committee_id)
          AND (SELECT count(*) FROM public.entity_tags et2
                WHERE et2.entity_id = c.donor_id
                  AND et2.entity_type = 'financial_entity'
                  AND et2.tag_category = 'industry') = 1
        LIMIT 1`,
    );
    if (probe.rows.length === 0 || !probe.rows[0].new_industry) {
      throw new Error("no probe (official, donor, target-industry) triple found — inspect manually");
    }
    const p = probe.rows[0] as {
      official_id: string; old_industry: string; total_cents: string; rank: string;
      donor_id: string; fec_committee_id: string; display_name: string; new_industry: string;
    };
    console.log(
      `\n=== Proofs B+C — targeted + single-run lag ===\n` +
        `  probe donor:    ${p.display_name} [${p.fec_committee_id}] (${p.old_industry} → ${p.new_industry})\n` +
        `  probe official: ${p.official_id} (sector at rank ${p.rank}, ${p.total_cents} cents, sole donor)`,
    );

    const expectedOfficials = await pg.query(
      `SELECT count(DISTINCT fr.to_id)::int AS n
         FROM public.financial_relationships fr
        WHERE fr.from_id = $1
          AND fr.relationship_type = 'donation'
          AND fr.from_type = 'financial_entity'
          AND fr.to_type   = 'official'
          AND fr.amount_cents > 0`,
      [p.donor_id],
    );
    const expectedN = (expectedOfficials.rows[0] as { n: number }).n;
    console.log(`  expected officials to rebuild: ${expectedN} (this donor's distinct recipients)`);

    await pg.query(
      `INSERT INTO public.financial_entity_industry_overrides
         (fec_committee_id, industry, display_name_at_audit, audited_sector, source)
       VALUES ($1, $2, $3, 'verify_probe', $4)`,
      [p.fec_committee_id, p.new_industry, p.display_name, PROBE_SOURCE],
    );

    // ONE full tagger run — the real nightly order is itself under test.
    await runRuleBasedTagger();

    const b = await lastRefreshRow(pg);
    assert(b.path === "targeted", "B: refresh took the targeted path", `path=${b.path}`);
    assert(b.donors_changed === 1, "B: exactly one donor in the diff", `donors=${b.donors_changed}`);
    assert(b.officials_affected === expectedN,
      `B: rebuilt exactly the donor's recipients (${expectedN}), not the backfill population`,
      `officials_affected=${b.officials_affected}`);

    const moved = await pg.query(
      `SELECT (SELECT total_cents FROM public.official_sector_affinity_rollup
                WHERE official_id = $1 AND industry = $2)::text AS new_cents,
              (SELECT total_cents FROM public.official_sector_affinity_rollup
                WHERE official_id = $1 AND industry = $3)::text AS old_cents,
              EXISTS (SELECT 1 FROM public.entity_tags
                       WHERE entity_type = 'official' AND entity_id = $1
                         AND tag_category = 'industry' AND tag = $2) AS pill`,
      [p.official_id, p.new_industry, p.old_industry],
    );
    const m = moved.rows[0] as { new_cents: string | null; old_cents: string | null; pill: boolean };
    assert(m.new_cents === p.total_cents,
      "B: sector dollars moved to the new industry exactly",
      `expected=${p.total_cents} got=${m.new_cents}`);
    assert(m.old_cents === null, "B: old single-donor sector row is gone", `old=${m.old_cents}`);
    assert(m.pill === true,
      "C: the official's pill reflects the flip after ONE run (lag proof)",
      `pill for ${p.new_industry} missing on ${p.official_id}`);
    await conservation(pg);

    // ── Restore ──────────────────────────────────────────────────────────────
    console.log("\n=== Restore — remove the probe override, one more pass ===");
    await pg.query(
      `DELETE FROM public.financial_entity_industry_overrides WHERE source = $1`,
      [PROBE_SOURCE],
    );
    await tagFinancialEntities(db);
    await callHeavyProcedure("refresh_sector_affinity_from_tag_changes");
    await tagOfficials(db);
    const rr = await lastRefreshRow(pg);
    assert(rr.path === "targeted" && rr.donors_changed === 1,
      "restore: targeted single-donor refresh again", `path=${rr.path} donors=${rr.donors_changed}`);
    const restored = await pg.query(
      `SELECT (SELECT total_cents FROM public.official_sector_affinity_rollup
                WHERE official_id = $1 AND industry = $2)::text AS old_cents,
              EXISTS (SELECT 1 FROM public.entity_tags
                       WHERE entity_type = 'official' AND entity_id = $1
                         AND tag_category = 'industry' AND tag = $3) AS probe_pill`,
      [p.official_id, p.old_industry, p.new_industry],
    );
    const rs = restored.rows[0] as { old_cents: string | null; probe_pill: boolean };
    assert(rs.old_cents === p.total_cents, "restore: original sector row back",
      `expected=${p.total_cents} got=${rs.old_cents}`);
    assert(rs.probe_pill === false, "restore: probe pill removed");
    await conservation(pg);

    // ── Proof D: the alarm ───────────────────────────────────────────────────
    console.log("\n=== Proof D — staleness alarm ===");
    const d0 = await pg.query(`SELECT public.check_sector_affinity_tag_staleness() AS r`);
    const d0r = d0.rows[0].r as { stale: boolean; state: string };
    assert(d0r.state === "match" && d0r.stale === false, "D: quiet on a no-op night",
      `state=${d0r.state} stale=${d0r.stale}`);

    await pg.query(
      `UPDATE public.pipeline_state
          SET value = jsonb_set(value, '{sig}', '"0|synthetic-strand"')
        WHERE key = $1`,
      [SIG_KEY],
    );
    const d1 = await pg.query(`SELECT public.check_sector_affinity_tag_staleness() AS r`);
    const d1r = d1.rows[0].r as { stale: boolean; state: string };
    assert(d1r.state === "pending" && d1r.stale === false,
      "D: fresh mismatch is 'pending', not an alarm (one nightly cycle of grace)",
      `state=${d1r.state} stale=${d1r.stale}`);

    await pg.query(
      `UPDATE public.pipeline_state
          SET value = jsonb_set(value, '{first_mismatch_at}',
                                to_jsonb((now() - interval '27 hours')::text))
        WHERE key = $1`,
      [PROBE_KEY],
    );
    const d2 = await pg.query(`SELECT public.check_sector_affinity_tag_staleness() AS r`);
    const d2r = d2.rows[0].r as { stale: boolean; state: string; hours_outstanding: number };
    assert(d2r.stale === true && d2r.state === "stranded",
      "D: alarm fires once the mismatch is outstanding >26h",
      `state=${d2r.state} stale=${d2r.stale} hours=${d2r.hours_outstanding}`);

    // Heal the synthetic strand: put the true signature back.
    await pg.query(
      `UPDATE public.pipeline_state
          SET value = jsonb_set(value, '{sig}',
                                to_jsonb(public.compute_fe_industry_tag_signature()))
        WHERE key = $1`,
      [SIG_KEY],
    );
    const d3 = await pg.query(`SELECT public.check_sector_affinity_tag_staleness() AS r`);
    const d3r = d3.rows[0].r as { stale: boolean; state: string };
    const probeGone = await pg.query(
      `SELECT count(*)::int AS n FROM public.pipeline_state WHERE key = $1`, [PROBE_KEY]);
    assert(d3r.state === "match" && d3r.stale === false, "D: heals on match",
      `state=${d3r.state}`);
    assert((probeGone.rows[0] as { n: number }).n === 0, "D: probe cleared on match");

    // ── FIX-923 — the tightened FIX-909 tolerance, re-runnable form ──────────
    console.log("\n=== FIX-923 — zero out-of-vocabulary (tightened FIX-909 tolerance) ===");
    const oov = await pg.query(
      `SELECT count(*) FILTER (WHERE tag = 'other')::int AS other_rows,
              count(*)::int AS oov_rows
         FROM public.entity_tags
        WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
          AND tag <> ALL (ARRAY['health','oil_gas','finance','tech','defense',
                                'real_estate','labor','agriculture','legal',
                                'retail','transportation','lobby','utilities',
                                'manufacturing','mining','media'])`,
    );
    const o = oov.rows[0] as { other_rows: number; oov_rows: number };
    assert(o.other_rows === 0, "923: zero `other` industry rows", `other=${o.other_rows}`);
    assert(o.oov_rows === 0, "923: zero out-of-vocabulary industry rows", `oov=${o.oov_rows}`);
    const hrpac = await pg.query(
      `SELECT et.tag, et.generated_by
         FROM public.entity_tags et
         JOIN public.financial_entities fe ON fe.id = et.entity_id
        WHERE fe.fec_committee_id = 'C00448993'
          AND et.entity_type = 'financial_entity' AND et.tag_category = 'industry'`,
    );
    assert(
      hrpac.rows.length === 1 && hrpac.rows[0].tag === "health" && hrpac.rows[0].generated_by === "curated",
      "923: HRPAC carries exactly one curated `health` tag",
      JSON.stringify(hrpac.rows),
    );

    console.log(`\n=== ${failures === 0 ? "ALL PROOFS PASS" : `${failures} FAILURE(S)`} ===`);
    console.log(`  signature (steady state): ${a2.sig}`);
    console.log(`  targeted rebuild size:    ${b.officials_affected} official(s) (expected ${expectedN})`);
  } finally {
    // Never leave the probe override behind, even on a failed run.
    await pg.query(
      `DELETE FROM public.financial_entity_industry_overrides WHERE source = $1`,
      [PROBE_SOURCE],
    ).catch(() => {});
    await pg.end();
  }

  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
