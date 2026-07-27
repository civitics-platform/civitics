/**
 * FIX-859 — backfill officials.metadata->>'district_jurisdiction_id' for STATE
 * legislators (Path A of the choropleth work; FIX-855 shipped Path B, the
 * congressional band).
 *
 * THE JOIN MUST BE SCOPED BY STATE. officials.district_name for a state
 * legislator is a bare token with no state in it — "10" appears on 99 different
 * officials across 50 states, so an unscoped join on district_name is not
 * merely lossy, it is actively wrong. The state comes from the official's
 * governing_bodies.jurisdiction_id; the district jurisdiction's parent_id
 * points at that same state row (every HD/SD district row has
 * parent_type='state'). Chamber comes from the short_name prefix — 'HD' for
 * gb.type='legislature_lower', 'SD' for 'legislature_upper'.
 * metadata->>'district_type' is NULL everywhere; it is not usable.
 *
 * FIVE MATCH TIERS, strongest first. A link is written ONLY where the strongest
 * tier that produced any match produced EXACTLY ONE match. 0 or >1 is counted
 * and reported, never written.
 *
 *   1  numeric      zero-pad-normalised district number. jurisdictions key on
 *                   metadata->>'district_id' ('066') / short_name ('HD 066');
 *                   officials carry the raw form ('66'). ltrim(…,'0') both.
 *   2  multi-member Idaho-style '10A'/'10B' — two House seats inside one
 *                   geographic district. Strip the trailing letter, redo tier 1.
 *                   Two officials CORRECTLY sharing one district_jurisdiction_id
 *                   is the expected outcome here, not a bug.
 *   3  exact core   Both sides reduced to a bare district "core" (state name and
 *                   per-state boilerplate stripped, separators folded) and
 *                   compared for EQUALITY. Equality rather than containment is
 *                   what keeps 'First Essex' off 'First Essex and Middlesex' —
 *                   containment-first made those ambiguous.
 *   4  squashed     Same cores with separators removed, for
 *                   'Chittenden South East' vs 'Chittenden Southeast'.
 *   5  containment  Anchored on '-' boundaries. Last resort, and in practice it
 *                   resolves nothing tiers 3–4 missed; kept as a safety net.
 *
 * KNOWN PERMANENT RESIDUAL (correct to leave unlinked):
 *   - NH floterial districts. New Hampshire has 164 HD jurisdiction rows for a
 *     400-member House; floterial seats have no row to link to. Do not invent
 *     rows — that is a separate seeding FIX.
 *   - ME tribal seats ('Passamaquoddy Tribe', 'Houlton Band of Maliseet
 *     Indians'). Non-geographic representation; correctly unlinked forever.
 *
 * Idempotent and re-runnable: the candidate pool is restricted to officials
 * whose district_jurisdiction_id IS NULL, and the UPDATE re-asserts that in its
 * WHERE clause. The script only ever ADDS the key — it never overwrites an
 * existing value and never removes other metadata keys (jsonb_set on a
 * coalesce'd object). A second run reports 0 writes.
 *
 * No hardcoded UUIDs — every id is derived by join, so the script behaves
 * identically against local and prod (prod UUIDs differ from local).
 *
 * Single direct pg.Client with statement_timeout=0, per the repo's heavy-write
 * convention — sidesteps both the PostgREST 1000-row cap and the prod
 * service_role 8s statement timeout.
 *
 * Run local (executes by default — local is disposable per the DB safety rules):
 *   pnpm --filter @civitics/data data:backfill:sld-links
 *   pnpm --filter @civitics/data data:backfill:sld-links -- --dry-run   # plan only
 *
 * Prod is GATED: the plan variant prints live counts and STOPS (no writes).
 *   pnpm --filter @civitics/data data:backfill:sld-links:prod:plan
 * Only after explicit confirmation in chat, run the executing variant:
 *   pnpm --filter @civitics/data data:backfill:sld-links:prod
 */

import { Client } from "pg";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

/**
 * SQL expression reducing a district label to a comparable "core".
 *
 * Both a jurisdiction name and an official's district_name go through the same
 * pipeline, so the two sides meet in the middle:
 *
 *   'New Hampshire State House District Belknap 01'  → 'belknap-01'
 *   'Belknap 1'                                      → 'belknap-01'
 *   'Massachusetts Berkshire-Hampden-Franklin-Hampshire District'
 *                                                    → 'berkshire-hampden-franklin-hampshire'
 *   'Berkshire, Hampden, Franklin and Hampshire'     → 'berkshire-hampden-franklin-hampshire'
 *   'Vermont Addison-1 State House District'         → 'addison-01'
 *
 * Steps: lowercase → strip the leading state name → strip the per-state
 * boilerplate (longest alternative first, so 'senatorial district' wins over
 * the bare 'district') → ' and ' to '-' → any other separator run to '-' →
 * trim '-' → zero-pad a trailing single digit ('belknap-1' → 'belknap-01',
 * which is how the jurisdiction rows are written).
 */
function coreKey(valueExpr: string, stateExpr: string): string {
  return `regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(${valueExpr}), '^' || lower(${stateExpr}) || '\\s+', ''),
            '\\m(state house district|state senate district|senatorial district|house district|senate district|district)\\M', ' ', 'g'),
          '\\s+and\\s+', '-', 'g'),
        '[^a-z0-9]+', '-', 'g'),
      '^-+|-+$', '', 'g'),
    '-([0-9])$', '-0\\1')`;
}

/** Candidate pool + all five tiers, resolved to one row per official. */
const MATCH_SQL = `
WITH sl AS (
  SELECT o.id,
         o.district_name,
         gb.type AS chamber,
         gb.jurisdiction_id AS state_id,
         p.name AS state,
         CASE gb.type WHEN 'legislature_lower' THEN 'HD' ELSE 'SD' END AS prefix,
         ltrim(o.district_name, '0') AS num_key,
         CASE WHEN o.district_name ~ '^[0-9]+[A-Za-z]$'
              THEN ltrim(regexp_replace(o.district_name, '[A-Za-z]$', ''), '0') END AS num_key_mm,
         ${coreKey("o.district_name", "p.name")} AS nk
  FROM public.officials o
  JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
  JOIN public.jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
  WHERE gb.type IN ('legislature_lower', 'legislature_upper')
    AND o.is_active
    AND NOT COALESCE(o.is_synthetic, false)
    AND o.metadata->>'district_jurisdiction_id' IS NULL
    AND o.district_name IS NOT NULL
    AND btrim(o.district_name) <> ''
),
dj AS (
  SELECT d.id,
         d.parent_id,
         split_part(d.short_name, ' ', 1) AS prefix,
         ltrim(coalesce(d.metadata->>'district_id', split_part(d.short_name, ' ', 2)), '0') AS num_key,
         ${coreKey("d.name", "p.name")} AS nk
  FROM public.jurisdictions d
  JOIN public.jurisdictions p ON p.id = d.parent_id AND p.type = 'state'
  WHERE d.type = 'district'
    AND split_part(d.short_name, ' ', 1) IN ('HD', 'SD')
),
m AS (
  SELECT sl.id AS official_id, sl.state, sl.chamber, sl.district_name, dj.id AS jur_id,
    CASE
      WHEN dj.num_key <> '' AND dj.num_key = sl.num_key                              THEN 1
      WHEN dj.num_key <> '' AND sl.num_key_mm IS NOT NULL
           AND dj.num_key = sl.num_key_mm                                            THEN 2
      WHEN sl.nk <> '' AND dj.nk = sl.nk                                              THEN 3
      WHEN sl.nk <> '' AND replace(dj.nk, '-', '') = replace(sl.nk, '-', '')          THEN 4
      WHEN sl.nk <> '' AND dj.nk ~ ('(^|-)' || sl.nk || '($|-)')                      THEN 5
    END AS tier
  FROM sl
  JOIN dj ON dj.parent_id = sl.state_id AND dj.prefix = sl.prefix
),
best AS (
  SELECT official_id, min(tier) AS tier FROM m WHERE tier IS NOT NULL GROUP BY 1
)
SELECT sl.id AS official_id,
       sl.state,
       sl.chamber,
       sl.district_name,
       b.tier,
       coalesce(agg.n, 0) AS n,
       agg.jur_id
FROM sl
LEFT JOIN best b ON b.official_id = sl.id
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n, min(m.jur_id::text)::uuid AS jur_id
  FROM m WHERE m.official_id = sl.id AND m.tier = b.tier
) agg ON b.tier IS NOT NULL`;

interface MatchRow {
  official_id: string;
  state: string;
  chamber: string;
  district_name: string;
  tier: number | null;
  n: number;
  jur_id: string | null;
}

function table(rows: Array<Record<string, string | number>>, cols: string[]): string {
  if (rows.length === 0) return "    (none)";
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: Array<string | number>) =>
    "    " + cells.map((v, i) => String(v ?? "").padEnd(w[i])).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c] ?? "")))].join("\n");
}

const TIER_LABEL: Record<number, string> = {
  1: "1 numeric (zero-pad normalised)",
  2: "2 multi-member (trailing letter stripped)",
  3: "3 exact normalised core",
  4: "4 squashed core (separators removed)",
  5: "5 anchored containment",
};

async function main(): Promise<void> {
  const prod = isProd();
  const allowProd = process.argv.includes("--allow-prod");
  const confirm = process.argv.includes("--confirm");
  const dryRun = process.argv.includes("--dry-run");

  if (prod && !allowProd) {
    console.error(
      "✗ Active env points at PROD but --allow-prod was not passed.\n" +
        "  Use `…:prod:plan` to preview (no writes), then — after explicit\n" +
        "  confirmation — `…:prod` to execute. Refusing to touch prod by accident.",
    );
    process.exit(1);
  }
  // Execute by default on local; on prod require --confirm (the chat gate).
  const willExecute = dryRun ? false : prod ? confirm : true;

  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  await client.query("SET statement_timeout = 0");

  try {
    console.log(`\n══ FIX-859 · state-legislature district_jurisdiction_id backfill ══`);
    console.log(`   target : ${prod ? "PRODUCTION (Supabase Pro)" : "LOCAL (Docker)"}`);
    console.log(
      `   mode   : ${
        willExecute ? (prod ? "PROD WRITE (--allow-prod --confirm given)" : "EXECUTE") : "DRY RUN — no writes"
      }\n`,
    );

    // ── Baseline ──────────────────────────────────────────────────────────
    const base = (
      await client.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE o.metadata->>'district_jurisdiction_id' IS NOT NULL)::int AS linked
      FROM public.officials o
      JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
      JOIN public.jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
      WHERE gb.type IN ('legislature_lower','legislature_upper')
        AND o.is_active AND NOT COALESCE(o.is_synthetic, false)`)
    ).rows[0] as { total: number; linked: number };
    const pct = (n: number) => `${((n / base.total) * 100).toFixed(1)}%`;
    console.log(`── BEFORE ──`);
    console.log(`   state legislators (active, non-synthetic): ${base.total}`);
    console.log(`   already linked:                            ${base.linked}  (${pct(base.linked)})`);
    console.log(`   unlinked:                                  ${base.total - base.linked}\n`);

    // ── Match ─────────────────────────────────────────────────────────────
    const rows = (await client.query(MATCH_SQL)).rows as MatchRow[];
    const resolved = rows.filter((r) => r.tier !== null && r.n === 1);
    const ambiguous = rows.filter((r) => r.tier !== null && r.n > 1);
    const unresolved = rows.filter((r) => r.tier === null);

    console.log(`── MATCH PASS (pool = ${rows.length} unlinked) ──`);
    const byTier = Object.keys(TIER_LABEL)
      .map(Number)
      .map((t) => ({
        tier: TIER_LABEL[t],
        resolved: resolved.filter((r) => r.tier === t).length,
        ambiguous: ambiguous.filter((r) => r.tier === t).length,
      }))
      .filter((r) => r.resolved > 0 || r.ambiguous > 0);
    console.log(table(byTier, ["tier", "resolved", "ambiguous"]));
    console.log(
      `\n   resolved (exactly 1 match): ${resolved.length}` +
        `\n   ambiguous (>1, NOT written): ${ambiguous.length}` +
        `\n   unresolved (0 matches):      ${unresolved.length}\n`,
    );

    if (ambiguous.length > 0) {
      console.log(`── AMBIGUOUS — skipped, need a rule ──`);
      console.log(
        table(
          ambiguous.slice(0, 40).map((r) => ({
            state: r.state,
            chamber: r.chamber,
            district_name: r.district_name,
            tier: r.tier ?? "",
            matches: r.n,
          })),
          ["state", "chamber", "district_name", "tier", "matches"],
        ),
      );
      if (ambiguous.length > 40) console.log(`    … and ${ambiguous.length - 40} more`);
      console.log("");
    }

    if (unresolved.length > 0) {
      const grouped = new Map<string, { state: string; chamber: string; n: number; samples: string[] }>();
      for (const r of unresolved) {
        const k = `${r.state}|${r.chamber}`;
        const g = grouped.get(k) ?? { state: r.state, chamber: r.chamber, n: 0, samples: [] };
        g.n += 1;
        if (g.samples.length < 3) g.samples.push(r.district_name);
        grouped.set(k, g);
      }
      console.log(`── UNRESOLVED — by state × chamber ──`);
      console.log(
        table(
          [...grouped.values()]
            .sort((a, b) => b.n - a.n)
            .map((g) => ({ state: g.state, chamber: g.chamber, n: g.n, samples: g.samples.join(", ") })),
          ["state", "chamber", "n", "samples"],
        ),
      );
      console.log("");
    }

    // ── Write ─────────────────────────────────────────────────────────────
    if (!willExecute) {
      console.log(
        `── NO WRITES ──\n   ${resolved.length} link(s) would be added.` +
          (prod
            ? `\n   Prod execution is gated: re-run with the executing variant (…:prod, which\n` +
              `   adds --confirm) only after explicit confirmation of the counts above.`
            : `\n   (--dry-run given.)`),
      );
      return;
    }

    let written = 0;
    const BATCH = 1000;
    for (let i = 0; i < resolved.length; i += BATCH) {
      const slice = resolved.slice(i, i + BATCH);
      const res = await client.query(
        `UPDATE public.officials o
            SET metadata = jsonb_set(coalesce(o.metadata, '{}'::jsonb),
                                     '{district_jurisdiction_id}',
                                     to_jsonb(v.jid::text))
           FROM (SELECT unnest($1::uuid[]) AS oid, unnest($2::uuid[]) AS jid) v
          WHERE o.id = v.oid
            AND o.metadata->>'district_jurisdiction_id' IS NULL`,
        [slice.map((r) => r.official_id), slice.map((r) => r.jur_id)],
      );
      written += res.rowCount ?? 0;
      console.log(`   wrote ${written}/${resolved.length}…`);
    }

    // ── Verify ────────────────────────────────────────────────────────────
    const after = (
      await client.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE o.metadata->>'district_jurisdiction_id' IS NOT NULL)::int AS linked
      FROM public.officials o
      JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
      JOIN public.jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
      WHERE gb.type IN ('legislature_lower','legislature_upper')
        AND o.is_active AND NOT COALESCE(o.is_synthetic, false)`)
    ).rows[0] as { total: number; linked: number };

    console.log(`\n── AFTER ──`);
    console.log(`   rows written:  ${written}  (expected ${resolved.length})`);
    console.log(`   linked:        ${after.linked} / ${after.total}  (${((after.linked / after.total) * 100).toFixed(1)}%)`);
    console.log(`   delta:         +${after.linked - base.linked}`);
    if (written !== resolved.length) {
      console.error(`\n✗ write count ${written} != resolved ${resolved.length} — investigate before trusting this run.`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ backfill complete.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
