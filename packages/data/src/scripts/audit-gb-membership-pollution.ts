/**
 * FIX-470 — governing_body membership-pollution audit (read-only).
 *
 * Quantifies how `officials.governing_body_id` is used as a parking lot:
 * every FEC candidate (cn{yy}.zip, FIX-246) gets attached to the body it
 * runs for with `tier='candidate'`, so a legislature gb's "active officials"
 * count is inflated by the entire candidate field. The `/institutions/[id]`
 * roster / party-balance / member-count queries filter on `is_active` only,
 * never `tier`, so they over-count members massively.
 *
 * This script measures, for the ACTIVE env (local Docker or prod via
 * --env-file=.env.local.prod), the data behind that claim. It is strictly
 * read-only: the connection runs with `default_transaction_read_only = on`,
 * so any accidental DML aborts.
 *
 * Run local:
 *   pnpm --filter @civitics/data diag:gb-membership
 * Run prod (read-only):
 *   pnpm --filter @civitics/data diag:gb-membership:prod
 *
 * Emits a self-contained markdown report to stdout — redirect to compose the
 * audit doc, e.g. `… diag:gb-membership > /tmp/local.md`. Mirrors the
 * chamber-scoping precedent from get_institution_recent_votes v2 (FIX-439):
 * legislature_upper → 'Senate', legislature_lower → 'House'.
 */

import { Client } from "pg";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    // local Docker
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

type Row = Record<string, unknown>;

function mdTable(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

async function q(client: Client, sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await client.query(sql, params);
  return res.rows as Row[];
}

async function main(): Promise<void> {
  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  const env = isProd() ? "prod (xsazcoxinpgttgquwvuf)" : "local Docker";

  const client = new Client({ connectionString: url });
  await client.connect();
  // Belt-and-braces read-only: any DML aborts.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '120s'");

  const out: string[] = [];
  const p = (s = "") => out.push(s);

  p(`# governing_body membership-pollution audit — ${env}`);
  p();
  p(`**Connection:** \`${masked}\``);
  p(`**Read-only:** \`default_transaction_read_only = on\``);
  p();

  // ── (a) Tier coverage / predicate safety ──────────────────────────────
  p(`## a. Tier coverage (predicate safety)`);
  p();
  const tierDist = await q(
    client,
    `SELECT COALESCE(tier, '(NULL)') AS tier, COUNT(*)::int AS n
       FROM officials GROUP BY tier ORDER BY n DESC`
  );
  p(
    mdTable(
      ["tier", "officials"],
      tierDist.map((r) => [String(r.tier), Number(r.n)])
    )
  );
  p();
  const nullTier = await q(
    client,
    `SELECT COUNT(*) FILTER (WHERE tier IS NULL)::int AS null_tier,
            COUNT(*) FILTER (WHERE tier IS NULL AND is_active)::int AS null_tier_active,
            COUNT(*) FILTER (WHERE tier IS NULL AND governing_body_id IS NOT NULL)::int AS null_tier_on_gb
       FROM officials`
  );
  const nt = nullTier[0];
  p(
    `- NULL tier total: **${nt.null_tier}** · active NULL tier: **${nt.null_tier_active}** · NULL tier attached to a gb: **${nt.null_tier_on_gb}**`
  );
  p(
    `- Predicate decision: \`is_active = true AND tier = 'elected'\`. NULL tiers are **excluded** (treated as non-members). ${
      Number(nt.null_tier_on_gb) === 0
        ? "Zero NULL-tier rows are attached to a gb, so the exclusion hides nothing here."
        : "⚠️ NULL-tier rows ARE attached to gbs — see follow-up on tier backfill."
    }`
  );
  p();

  // ── (b) Per-gb composition (top 15 by attached officials) ─────────────
  p(`## b. Per-gb composition — top 15 governing bodies by attached officials`);
  p();
  const topGbs = await q(
    client,
    `SELECT o.governing_body_id AS gb_id, g.name, g.type, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier = 'elected')::int AS elected_active,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier = 'candidate')::int AS candidate_active,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier = 'former')::int AS former_active,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier IS NULL)::int AS null_active,
            COUNT(*) FILTER (WHERE o.is_active)::int AS active_total
       FROM officials o
       JOIN governing_bodies g ON g.id = o.governing_body_id
      WHERE o.governing_body_id IS NOT NULL
      GROUP BY o.governing_body_id, g.name, g.type
      ORDER BY total DESC
      LIMIT 15`
  );
  p(
    mdTable(
      ["gb", "type", "attached", "active", "active elected", "active candidate", "active former", "active NULL"],
      topGbs.map((r) => [
        String(r.name).slice(0, 40),
        String(r.type),
        Number(r.total),
        Number(r.active_total),
        Number(r.elected_active),
        Number(r.candidate_active),
        Number(r.former_active),
        Number(r.null_active),
      ])
    )
  );
  p();
  p(
    `> "active" = current display query result (\`is_active\` only). "active elected" = proposed current-member predicate result (\`is_active AND tier='elected'\`).`
  );
  p();

  // Top role_titles per top gb (active elected only — what a roster shows post-fix)
  p(`### Top active-elected role_titles for the top 5 gbs (post-fix roster shape)`);
  p();
  for (const g of topGbs.slice(0, 5)) {
    const roles = await q(
      client,
      `SELECT COALESCE(role_title, '(NULL)') AS role_title, COUNT(*)::int AS n
         FROM officials
        WHERE governing_body_id = $1 AND is_active AND tier = 'elected'
        GROUP BY role_title ORDER BY n DESC LIMIT 5`,
      [g.gb_id]
    );
    const rolesStr = roles.length
      ? roles.map((r) => `${r.role_title} (${r.n})`).join(", ")
      : "— none —";
    p(`- **${g.name}** [${g.type}], elected-active=${g.elected_active}: ${rolesStr}`);
  }
  p();

  // ── (c) Cross-chamber misassignment (tier does NOT catch this) ────────
  p(`## c. Cross-chamber misassignment among elected-active officials`);
  p();
  const crossChamber = await q(
    client,
    `WITH elected AS (
       SELECT o.id,
              CASE g.type WHEN 'legislature_upper' THEN 'Senate'
                          WHEN 'legislature_lower' THEN 'House' END AS expected
         FROM officials o
         JOIN governing_bodies g ON g.id = o.governing_body_id
        WHERE o.tier = 'elected' AND o.is_active
          AND g.type IN ('legislature_upper', 'legislature_lower')
     ),
     recent_vote AS (
       SELECT DISTINCT ON (v.official_id) v.official_id, v.chamber
         FROM votes v
        WHERE v.voted_at > now() - interval '180 days'
        ORDER BY v.official_id, v.voted_at DESC
     )
     SELECT e.expected,
            COUNT(*)::int AS elected_active,
            COUNT(rv.official_id)::int AS with_recent_vote,
            COUNT(*) FILTER (WHERE rv.chamber IS NOT NULL AND rv.chamber <> e.expected)::int AS mismatched
       FROM elected e
       LEFT JOIN recent_vote rv ON rv.official_id = e.id
      WHERE e.expected IS NOT NULL
      GROUP BY e.expected
      ORDER BY e.expected`
  );
  p(
    mdTable(
      ["gb chamber (expected)", "elected-active", "with recent vote", "most-recent vote in WRONG chamber"],
      crossChamber.map((r) => [
        String(r.expected),
        Number(r.elected_active),
        Number(r.with_recent_vote),
        Number(r.mismatched),
      ])
    )
  );
  p();
  const totalMismatch = crossChamber.reduce((a, r) => a + Number(r.mismatched), 0);
  p(
    `- Total elected-active officials whose most-recent (180d) vote is in the wrong chamber for their gb: **${totalMismatch}**. Tier scoping does NOT catch this class — it is orthogonal to the candidate pollution.`
  );
  p();

  // ── (d) Legistar / municipal-council person flood ─────────────────────
  p(`## d. Legistar / municipal-council person flood`);
  p();
  const councils = await q(
    client,
    `SELECT o.governing_body_id AS gb_id, g.name, g.type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE o.is_active)::int AS active_total,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier = 'elected')::int AS elected_active,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier = 'candidate')::int AS candidate_active,
            COUNT(*) FILTER (WHERE o.is_active AND o.tier IS NULL)::int AS null_active
       FROM officials o
       JOIN governing_bodies g ON g.id = o.governing_body_id
      WHERE o.governing_body_id IS NOT NULL
        AND (g.type IN ('municipal_council', 'legislature_unicameral')
             OR g.name ILIKE '%council%' OR g.name ILIKE '%agenda%' OR g.name ILIKE '%board%')
      GROUP BY o.governing_body_id, g.name, g.type
      ORDER BY total DESC
      LIMIT 20`
  );
  if (councils.length === 0) {
    p(`_No council/board/agenda governing bodies with attached officials in this env._`);
  } else {
    p(
      mdTable(
        ["gb", "type", "attached", "active", "active elected", "active candidate", "active NULL"],
        councils.map((r) => [
          String(r.name).slice(0, 44),
          String(r.type),
          Number(r.total),
          Number(r.active_total),
          Number(r.elected_active),
          Number(r.candidate_active),
          Number(r.null_active),
        ])
      )
    );
    p();
    p(
      `> Plausible council size is ~9–11. If "active elected" yields that, tier scoping fixes municipal rosters too; if it yields 0 or implausible counts, Legistar person ingestion needs its own scoping FIX.`
    );
  }
  p();

  // Role-title breakdown for the single biggest council body (characterize what Legistar attaches)
  if (councils.length > 0) {
    const biggest = councils[0];
    const roles = await q(
      client,
      `SELECT COALESCE(tier,'(NULL)') AS tier, COALESCE(role_title,'(NULL)') AS role_title, COUNT(*)::int AS n
         FROM officials
        WHERE governing_body_id = $1 AND is_active
        GROUP BY tier, role_title ORDER BY n DESC LIMIT 12`,
      [biggest.gb_id]
    );
    p(`### Active-official role_titles on "${biggest.name}" (biggest council body)`);
    p();
    p(
      mdTable(
        ["tier", "role_title", "n"],
        roles.map((r) => [String(r.tier), String(r.role_title).slice(0, 40), Number(r.n)])
      )
    );
    p();
  }

  await client.end();
  process.stdout.write(out.join("\n") + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
