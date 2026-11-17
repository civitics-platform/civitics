/**
 * FIX-1417 — senate-117-1-00059's 78 invented `not_voting` rows.
 *
 * The 2021 impeachment verdict roll ("Guilty or Not Guilty", 2021-02-13) was
 * stored when mapVote defaulted every cast it did not know to `not_voting`, so
 * all 78 matched members read `not_voting`. Since cc-291 mapVote maps `Guilty`
 * to yes and `Not Guilty` to no. This script corrects the stored rows from the
 * roll as published.
 *
 * TWO MODES
 *
 *   --build --xml <file>    Read one saved copy of the roll's LIS XML (cc-291
 *                           made the one GET through the walk's fetchText),
 *                           parse it with the walk's parseSenateRoll, key each
 *                           member the walk's way (senateNameKey(last_name,
 *                           state)), match the target's stored rows, and write
 *                           the manifest TSV. Writes no row.
 *   (default)               Read the manifest and correct the stored rows. DRY
 *                           by default: the updates run inside a transaction
 *                           that is rolled back. `--apply` commits.
 *
 * Before / after counts by `vote` are printed in both modes. Every manifest
 * row is re-verified on the target before its UPDATE: same roll, still
 * `not_voting`, and the official keys to the manifest's member. A mismatch
 * aborts the whole transaction. Only rows still `not_voting` are touched, so a
 * second run is a no-op.
 *
 * Prod: refused without --allow-prod (the same rule as createAdminClient).
 * FIX-1417 stays OPEN until a supervised prompt applies this manifest on prod.
 *
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1417-verdict-roll.ts --build --xml <file>
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1417-verdict-roll.ts            # dry
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1417-verdict-roll.ts --apply
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { repoRoot } from "../lib/repo-root";
import { mapVote } from "../pipelines/congress/members";
import { parseSenateRoll } from "../pipelines/congress/votes";
import { senateNameKey } from "../pipelines/congress/votes-maps";

export const ROLL_CALL_ID = "senate-117-1-00059";
export const DEFAULT_MANIFEST = "docs/audits/2026-11-17-fix1417-verdict-roll.tsv";

export const MANIFEST_COLUMNS = [
  "lis_member_id",
  "member_key",
  "last_name",
  "first_name",
  "party",
  "state",
  "cast",
  "vote",
  "vote_id",
  "official_id",
] as const;

export type ManifestRow = Record<(typeof MANIFEST_COLUMNS)[number], string>;

/** One stored row of the roll on the target, keyed the walk's way. */
export interface StoredRow {
  vote_id: string;
  official_id: string;
  vote: string;
  member_key: string;
}

/** The roll's members as published, each with its mapped vote. */
export function membersFromXml(xml: string): Array<Omit<ManifestRow, "vote_id" | "official_id">> {
  const root = parseSenateRoll(xml);
  if (!root) throw new Error("not a Senate roll_call_vote document");
  const container = root["members"] as Record<string, unknown> | null;
  const raw = container?.["member"];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>;
  return list.map((m) => {
    const s = (k: string) => String(m[k] ?? "").trim();
    const cast = s("vote_cast");
    return {
      lis_member_id: s("lis_member_id"),
      member_key: senateNameKey(s("last_name"), s("state")),
      last_name: s("last_name"),
      first_name: s("first_name"),
      party: s("party"),
      state: s("state").toUpperCase(),
      cast,
      vote: mapVote(cast),
    };
  });
}

/** Attach each member's stored row (by member_key). A key two stored rows share is refused. */
export function buildManifest(
  members: ReturnType<typeof membersFromXml>,
  stored: readonly StoredRow[],
): ManifestRow[] {
  const byKey = new Map<string, StoredRow[]>();
  for (const r of stored) byKey.set(r.member_key, [...(byKey.get(r.member_key) ?? []), r]);
  return members.map((m) => {
    const hits = byKey.get(m.member_key) ?? [];
    const hit = hits.length === 1 ? hits[0]! : null;
    return { ...m, vote_id: hit?.vote_id ?? "", official_id: hit?.official_id ?? "" };
  });
}

export function toTsv(rows: readonly ManifestRow[]): string {
  return [MANIFEST_COLUMNS.join("\t"), ...rows.map((r) => MANIFEST_COLUMNS.map((c) => r[c]).join("\t"))].join("\n") + "\n";
}

export function parseTsv(text: string): ManifestRow[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l !== "");
  const head = lines.shift()?.split("\t") ?? [];
  if (head.join("\t") !== MANIFEST_COLUMNS.join("\t")) throw new Error(`manifest header is not ${MANIFEST_COLUMNS.join(",")}`);
  return lines.map((l) => {
    const cells = l.split("\t");
    return Object.fromEntries(MANIFEST_COLUMNS.map((c, i) => [c, cells[i] ?? ""])) as ManifestRow;
  });
}

/** yes / no / not_voting / unmatched — what the report quotes beside the 78. */
export function manifestCounts(rows: readonly ManifestRow[]): Record<string, number> {
  const out: Record<string, number> = { yes: 0, no: 0, not_voting: 0, unmatched: 0 };
  for (const r of rows) {
    if (r.vote_id === "") out["unmatched"]!++;
    else out[r.vote] = (out[r.vote] ?? 0) + 1;
  }
  return out;
}

async function readStored(client: Pick<Client, "query">): Promise<StoredRow[]> {
  const res = await client.query<{ vote_id: string; official_id: string; vote: string; last_name: string | null; state: string | null }>(
    `SELECT v.id AS vote_id, v.official_id, v.vote, o.last_name, j.short_name AS state
       FROM public.votes v
       JOIN public.officials o ON o.id = v.official_id
       LEFT JOIN public.jurisdictions j ON j.id = o.jurisdiction_id
      WHERE v.roll_call_id = $1`,
    [ROLL_CALL_ID],
  );
  return res.rows.map((r) => ({
    vote_id: r.vote_id,
    official_id: r.official_id,
    vote: r.vote,
    member_key: senateNameKey(r.last_name, r.state),
  }));
}

async function countsByVote(client: Pick<Client, "query">): Promise<string> {
  const res = await client.query<{ vote: string; n: string }>(
    "SELECT vote, count(*)::text AS n FROM public.votes WHERE roll_call_id = $1 GROUP BY vote ORDER BY vote",
    [ROLL_CALL_ID],
  );
  return res.rows.map((r) => `${r.vote}=${r.n}`).join(" ") || "(no rows)";
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dsn = buildDbUrl();
  const local = dsn.includes("127.0.0.1") || dsn.includes("localhost");
  if (!local && !argv.includes("--allow-prod")) {
    throw new Error("refusing a non-local database without --allow-prod");
  }
  const manifestPath = join(repoRoot("fix1417"), argValue(argv, "--manifest") ?? DEFAULT_MANIFEST);
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("SET statement_timeout = '60s'");
    console.info(`[fix1417] target ${local ? "LOCAL" : "PROD"} · roll ${ROLL_CALL_ID}`);
    console.info(`[fix1417] before: ${await countsByVote(client)}`);

    if (argv.includes("--build")) {
      const xmlPath = argValue(argv, "--xml");
      if (!xmlPath) throw new Error("--build needs --xml <saved LIS XML>");
      const manifest = buildManifest(membersFromXml(readFileSync(xmlPath, "utf8")), await readStored(client));
      writeFileSync(manifestPath, toTsv(manifest), "utf8");
      console.info(`[fix1417] wrote ${manifest.length} member rows → ${manifestPath}`);
      console.info(`[fix1417] manifest: ${JSON.stringify(manifestCounts(manifest))}`);
      return;
    }

    const manifest = parseTsv(readFileSync(manifestPath, "utf8")).filter((r) => r.vote_id !== "");
    console.info(`[fix1417] manifest ${manifestPath}: ${manifest.length} matched rows`);
    const stored = new Map((await readStored(client)).map((r) => [r.vote_id, r]));
    await client.query("BEGIN");
    let updated = 0;
    let already = 0;
    for (const m of manifest) {
      const s = stored.get(m.vote_id);
      if (!s) throw new Error(`vote row ${m.vote_id} (${m.member_key}) is not on this roll here`);
      if (s.member_key !== m.member_key || s.official_id !== m.official_id) {
        throw new Error(`vote row ${m.vote_id}: manifest ${m.member_key}/${m.official_id} ≠ target ${s.member_key}/${s.official_id}`);
      }
      if (s.vote === m.vote) {
        already++;
        continue;
      }
      if (s.vote !== "not_voting") throw new Error(`vote row ${m.vote_id} reads ${s.vote}, not not_voting — refusing`);
      const res = await client.query(
        "UPDATE public.votes SET vote = $1 WHERE id = $2 AND roll_call_id = $3 AND vote = 'not_voting'",
        [m.vote, m.vote_id, ROLL_CALL_ID],
      );
      updated += res.rowCount ?? 0;
    }
    const after = await countsByVote(client);
    if (argv.includes("--apply")) {
      await client.query("COMMIT");
      console.info(`[fix1417] APPLIED: ${updated} updated, ${already} already correct`);
      console.info(`[fix1417] after: ${after}`);
    } else {
      await client.query("ROLLBACK");
      console.info(`[fix1417] DRY RUN (rolled back): would update ${updated}, ${already} already correct`);
      console.info(`[fix1417] after (would be): ${after}`);
      console.info(`[fix1417] after (actual):   ${await countsByVote(client)}`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* no transaction open */ });
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[fix1417] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
