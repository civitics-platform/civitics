/**
 * data:seed:franklin:reset — delete ONLY the synthetic Franklin rows so the seed
 * can be re-applied from scratch (FIX-607).
 *
 * Destructive. Every delete is scoped to is_synthetic rows (or rows authored by
 * synthetic users / referencing synthetic entities) — it never touches real
 * data. Requires --yes to run, and prod additionally requires --allow-prod.
 *
 *   pnpm --filter @civitics/data data:seed:franklin:reset -- --yes
 *   pnpm --filter @civitics/data data:seed:franklin:reset -- --yes --db-url <url> --allow-prod
 */

import { Client } from "pg";
import { LOCAL_DB_URL } from "./lib";

/* eslint-disable no-console */

function isProdUrl(url: string): boolean {
  return /supabase\.(co|com)/i.test(url);
}
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dbUrl = process.env.SUPABASE_DB_URL ?? LOCAL_DB_URL;
  let allowProd = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--yes") yes = true;
  }

  const h = host(dbUrl);
  const prod = isProdUrl(dbUrl);
  if (!yes) {
    console.error("Refusing to delete synthetic rows without --yes.");
    process.exit(2);
  }
  if (prod && !allowProd) {
    console.error(`Refusing to reset what looks like prod (${h}) without --allow-prod.`);
    process.exit(2);
  }

  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({ connectionString: cleanUrl, ssl: wantsSsl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  console.log(`data:seed:franklin:reset — host=${h} ${prod ? "(PROD)" : "(local)"}`);

  // FK-safe order, every statement synthetic-scoped.
  const SYN_USERS = `(SELECT id FROM public.users WHERE is_synthetic)`;
  const SYN_PROPS = `(SELECT id FROM public.proposals WHERE is_synthetic)`;
  const SYN_FE = `(SELECT entity_id FROM public.synthetic_entities WHERE entity_type = 'financial_entity')`;
  const SYN_OFF = `(SELECT entity_id FROM public.synthetic_entities WHERE entity_type = 'official')`;

  const stmts: string[] = [
    // content flags on synthetic comments or by synthetic flaggers
    `DELETE FROM public.content_flags WHERE user_id IN ${SYN_USERS}
       OR (content_type = 'entity_comment' AND content_id IN (SELECT id FROM public.entity_comments WHERE author_id IN ${SYN_USERS}))`,
    `DELETE FROM public.entity_comments WHERE author_id IN ${SYN_USERS}`,
    `DELETE FROM public.entity_positions WHERE user_id IN ${SYN_USERS}`,
    // investigations cascade -> evidence_cards -> citations + edge audit
    `DELETE FROM public.investigations WHERE is_synthetic`,
    // graph edges promoted from synthetic investigation evidence
    `DELETE FROM public.entity_connections
       WHERE (from_type = 'financial_entity' AND from_id IN ${SYN_FE})
          OR (to_type   = 'financial_entity' AND to_id   IN ${SYN_FE})
          OR (from_type = 'official' AND from_id IN ${SYN_OFF})
          OR (to_type   = 'official' AND to_id   IN ${SYN_OFF})`,
    // initiative sub-tables (also cascade from the proposal delete, but explicit)
    `DELETE FROM public.civic_initiative_responses WHERE initiative_id IN ${SYN_PROPS}`,
    `DELETE FROM public.civic_initiative_signatures WHERE initiative_id IN ${SYN_PROPS}`,
    // proposals cascade -> bill_details -> votes, initiative_details
    `DELETE FROM public.proposals WHERE is_synthetic`,
    // money graph
    `DELETE FROM public.financial_relationships
       WHERE (from_type = 'financial_entity' AND from_id IN ${SYN_FE})
          OR (to_type   = 'financial_entity' AND to_id   IN ${SYN_FE})
          OR (from_type = 'official' AND from_id IN ${SYN_OFF})
          OR (to_type   = 'official' AND to_id   IN ${SYN_OFF})`,
    `DELETE FROM public.officials WHERE is_synthetic`,
    `DELETE FROM public.financial_entities WHERE is_synthetic`,
    `DELETE FROM public.agencies WHERE is_synthetic`,
    `DELETE FROM public.governing_bodies WHERE is_synthetic`,
    `DELETE FROM public.jurisdictions WHERE is_synthetic`,
    `DELETE FROM public.entity_grants WHERE user_id IN ${SYN_USERS}`,
    // public.users + auth.users (FK auth->public cascades public on auth delete)
    `DELETE FROM auth.users WHERE id IN ${SYN_USERS}`,
    `DELETE FROM public.franklin_seed_map`,
  ];

  await client.query("BEGIN");
  try {
    for (const sql of stmts) {
      const res = await client.query(sql);
      console.log(`  ${res.rowCount ?? 0}\t${sql.split("\n")[0].slice(12, 80)}…`);
    }
    await client.query("COMMIT");
    console.log("Reset complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reset failed, rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
