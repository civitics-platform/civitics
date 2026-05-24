/**
 * FIX-345 sub-probe — verify EXISTS-shape is fast enough to replace the
 * timed-out COUNT(*) shape for the drift source checks.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const client = new Client({
    connectionString: constructDbUrlFromEnv(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`Connected to: ${new URL(constructDbUrlFromEnv()).host}\n`);

  const explain = async (label: string, sql: string): Promise<void> => {
    console.log(`=== ${label} ===`);
    const start = Date.now();
    try {
      const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
      const wall = Date.now() - start;
      console.log(`-- wall-clock: ${wall} ms --`);
      for (const r of res.rows) console.log(r["QUERY PLAN"]);
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
    }
    console.log("");
  };

  // EXISTS variants — should be sub-ms with indexed predicate
  await explain(
    "EXISTS donation",
    `SELECT EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type='donation') AS x`,
  );
  await explain(
    "EXISTS contract OR grant",
    `SELECT EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('contract','grant')) AS x`,
  );

  // The composite RPC shape — 11 EXISTS in one query
  await explain(
    "composite RPC: 11 EXISTS via UNION ALL",
    `
    SELECT 'donation' AS rule_type, EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type='donation') AS has_rows
    UNION ALL SELECT 'vote_yes',    EXISTS (SELECT 1 FROM votes WHERE vote='yes')
    UNION ALL SELECT 'vote_no',     EXISTS (SELECT 1 FROM votes WHERE vote='no')
    UNION ALL SELECT 'vote_abstain', EXISTS (SELECT 1 FROM votes WHERE vote='abstain')
    UNION ALL SELECT 'co_sponsorship', EXISTS (SELECT 1 FROM proposal_cosponsors WHERE date_withdrawn IS NULL)
    UNION ALL SELECT 'appointment',  EXISTS (SELECT 1 FROM career_history WHERE is_government = true AND governing_body_id IS NOT NULL)
    UNION ALL SELECT 'oversight',    EXISTS (SELECT 1 FROM agencies WHERE governing_body_id IS NOT NULL)
    UNION ALL SELECT 'holds_position', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('owns_stock','owns_bond','property') AND ended_at IS NULL)
    UNION ALL SELECT 'gift_received', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('gift','honorarium'))
    UNION ALL SELECT 'contract_award', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('contract','grant'))
    UNION ALL SELECT 'lobbying',     EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type='lobbying_spend')
    `,
  );

  // Also: actually call it and measure wall-clock end-to-end
  console.log("=== wall-clock: composite EXISTS query (no EXPLAIN) ===");
  const start = Date.now();
  const res = await client.query(
    `
    SELECT 'donation' AS rule_type, EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type='donation') AS has_rows
    UNION ALL SELECT 'vote_yes',    EXISTS (SELECT 1 FROM votes WHERE vote='yes')
    UNION ALL SELECT 'vote_no',     EXISTS (SELECT 1 FROM votes WHERE vote='no')
    UNION ALL SELECT 'vote_abstain', EXISTS (SELECT 1 FROM votes WHERE vote='abstain')
    UNION ALL SELECT 'co_sponsorship', EXISTS (SELECT 1 FROM proposal_cosponsors WHERE date_withdrawn IS NULL)
    UNION ALL SELECT 'appointment',  EXISTS (SELECT 1 FROM career_history WHERE is_government = true AND governing_body_id IS NOT NULL)
    UNION ALL SELECT 'oversight',    EXISTS (SELECT 1 FROM agencies WHERE governing_body_id IS NOT NULL)
    UNION ALL SELECT 'holds_position', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('owns_stock','owns_bond','property') AND ended_at IS NULL)
    UNION ALL SELECT 'gift_received', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('gift','honorarium'))
    UNION ALL SELECT 'contract_award', EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type IN ('contract','grant'))
    UNION ALL SELECT 'lobbying',     EXISTS (SELECT 1 FROM financial_relationships WHERE relationship_type='lobbying_spend')
    `,
  );
  const wall = Date.now() - start;
  console.log(`-- wall-clock: ${wall} ms --`);
  console.table(res.rows);

  await client.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
