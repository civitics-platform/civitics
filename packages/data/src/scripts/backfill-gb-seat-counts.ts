/**
 * FIX-496 — backfill seat_count on state-chamber governing_bodies from the
 * static LEGISLATURE_SHAPES constants (jurisdictions/legislature-shapes.ts).
 *
 * seat_count was NULL on all 101 state-chamber rows (only US House/Senate/
 * OPOTUS were populated), so the FIX-490 roster-pollution canary in the graph
 * group route (warn when members > seat_count × 1.2) covered federal rows
 * only. This fills the state/territory/DC chambers so the canary watches the
 * cohort most likely to regress via ingest drift.
 *
 * Seat counts are stable public facts (NCSL-cited; change only by statute or
 * redistricting law), so they come from a static constants module shared with
 * the openstates chamber-shape resolution — deliberately NOT parsed from
 * openstates bulk data (Wave B decision 7).
 *
 * IDEMPOTENT, fill-only: updates seat_count ONLY where it is NULL — an
 * existing non-NULL value (federal rows, manual corrections) is never
 * overwritten. Re-running changes nothing once filled. This is a recurring
 * pipeline PASS, not a one-shot migration: run it again whenever new chamber
 * rows appear (e.g. after a fresh seed or the FIX-489/548 unicameral merge).
 *
 * Single pg.Client against the ACTIVE env, mirroring
 * backfill-gb-attribution.ts (FIX-477).
 *
 * Run local:
 *   pnpm --filter @civitics/data data:backfill-gb-seat-counts
 * Run prod (writes — requires the explicit allow flag):
 *   pnpm --filter @civitics/data data:backfill-gb-seat-counts:prod
 */

import { Client } from "pg";
import { LEGISLATURE_SHAPES } from "../jurisdictions/legislature-shapes";
import { STATE_DATA } from "../jurisdictions/us-states";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

function isProd(): boolean {
  return /supabase\.co/i.test(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "");
}

const SEAT_KEY: Record<string, "upper" | "lower" | "unicameral"> = {
  legislature_upper: "upper",
  legislature_lower: "lower",
  legislature_unicameral: "unicameral",
};

async function main(): Promise<void> {
  const prod = isProd();
  if (prod && !process.argv.includes("--allow-prod")) {
    console.error("✗ Active env points at PROD but --allow-prod was not passed. Refusing.");
    process.exit(1);
  }

  const url = buildDbUrl();
  console.log(`# FIX-496 — state-chamber seat_count backfill`);
  console.log(`Env:        ${prod ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker"}`);
  console.log(`Connection: ${url.replace(/:[^:@/]+@/, ":***@")}`);

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");

  try {
    // All state-level legislature chambers with NULL seat_count, joined to the
    // jurisdiction for the abbr key into LEGISLATURE_SHAPES. Federal rows
    // (country jurisdiction) are excluded by the type filter on jurisdictions
    // and would be skipped by the NULL filter anyway (seat_count populated).
    const { rows } = await client.query(
      `SELECT gb.id, gb.type, gb.name, j.short_name AS abbr
         FROM public.governing_bodies gb
         JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
        WHERE gb.type IN ('legislature_upper','legislature_lower','legislature_unicameral')
          AND gb.seat_count IS NULL
          AND j.type IN ('state','federal_district','unincorporated_territory')
        ORDER BY j.short_name, gb.type`,
    );

    const knownAbbrs = new Set(STATE_DATA.map((s) => s.abbr));
    let filled = 0;
    let skippedNoData = 0;

    for (const row of rows as Array<{ id: string; type: string; name: string; abbr: string | null }>) {
      const abbr = row.abbr ?? "";
      const shape = LEGISLATURE_SHAPES[abbr];
      const seatKey = SEAT_KEY[row.type];
      const seats = shape?.seats[seatKey];
      if (!shape || !seats) {
        // A chamber kind the shape table doesn't model for this jurisdiction
        // (e.g. a stray lower row in a unicameral jurisdiction pre-merge, or a
        // jurisdiction outside STATE_DATA). Loud skip, never a guess.
        skippedNoData++;
        console.warn(
          `  skip ${abbr || "??"} ${row.type} "${row.name}" — no seat constant` +
            (knownAbbrs.has(abbr) ? ` for ${seatKey} chamber` : ` (unknown jurisdiction abbr)`),
        );
        continue;
      }
      // Fill-only: the WHERE seat_count IS NULL re-check makes the update safe
      // against concurrent writes; never overwrites a non-NULL value.
      const res = await client.query(
        `UPDATE public.governing_bodies SET seat_count = $1, updated_at = NOW()
          WHERE id = $2 AND seat_count IS NULL`,
        [seats, row.id],
      );
      if (res.rowCount) {
        filled++;
        console.log(`  filled ${abbr} ${row.type} "${row.name}" → ${seats}`);
      }
    }

    const remaining = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM public.governing_bodies gb
         JOIN public.jurisdictions j ON j.id = gb.jurisdiction_id
        WHERE gb.type IN ('legislature_upper','legislature_lower','legislature_unicameral')
          AND gb.seat_count IS NULL
          AND j.type IN ('state','federal_district','unincorporated_territory')`,
    );

    console.log(`\nSeat backfill: ${filled} filled, ${skippedNoData} skipped (no constant), ${remaining.rows[0].n} still NULL`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
