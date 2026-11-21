/**
 * FIX-1416 — Senate nomination rolls stored on `bill` rows numbered `S <n>`.
 *
 * Until 61d072d8 (2026-04-28) the Senate walk's document-type normaliser fell
 * through to "S", so a roll whose <document> is a PN was stored against a
 * minted `bill` row numbered `S <PN number>`: `S 22-17` is PN 22-17, part 17.
 * Since then a PN roll resolves to `PN <n>`, type `appointment`, and the
 * nominations sync has minted those appointment proposals. This script moves
 * each such roll's vote rows from the stub to its PN proposal.
 *
 * MODES
 *
 *   --build            Read the target inside a READ ONLY transaction and write
 *                      the manifest TSV: one line per (roll, stub), `move` or
 *                      `skip: <why>`. Writes no row.
 *   (default)          Re-point the manifest's `move` rolls: `votes.bill_proposal_id`
 *                      stub → PN. DRY by default: the UPDATE runs inside a
 *                      transaction that is rolled back. `--apply` commits.
 *   --retire-stubs     Delete each dashed stub (`S <n>-<m>`, a number no bill can
 *                      hold) whose title is its number and which nothing points
 *                      at any more: every uuid column in public is swept for it
 *                      by value. Its bill_details row goes with it. Runs AFTER
 *                      the re-point and the votes merge. DRY unless `--apply`.
 *
 * The rules (cc-309 D2–D7):
 *   - a stub qualifies when it is typed `bill`, numbered `S <x>`, carries a
 *     Senate `On the Nomination` roll, and exactly one `appointment` proposal is
 *     numbered `PN <x>`; a PN that already carries one of the stub's roll ids
 *     refuses the stub;
 *   - every Senate roll on a dashed stub moves; on a short stub (`S 858` is also
 *     a real bill) a roll moves only when LIS_DOCUMENTS (read 4, one GET per
 *     roll) says its <document> is `PN <x>`, or, unread, its question is
 *     `On the Nomination`;
 *   - a roll whose rows are not all on the stub, or whose congress is not the
 *     PN's, is left out;
 *   - before the UPDATE every row is re-verified on the target: the roll's
 *     rows still all on the manifest's stub at the manifest's count, the PN
 *     still `appointment` with that number. A mismatch aborts the transaction.
 *     A roll already on its PN at that count is counted, not touched, so a
 *     second run is a no-op.
 *
 * The vote edges follow by the merge, not by this script: after the commit,
 * `SELECT * FROM public.rebuild_entity_connections_votes_full();` once, under
 * its own claim (FIX-1422: the incremental arm never retires a moved pair).
 *
 * Prod: refused without --allow-prod. FIX-1416 stays OPEN until a supervised
 * prompt applies this manifest on prod.
 *
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1416-nomination-rolls.ts --build
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1416-nomination-rolls.ts            # dry
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1416-nomination-rolls.ts --apply
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1416-nomination-rolls.ts --retire-stubs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { repoRoot } from "../lib/repo-root";

export const DEFAULT_MANIFEST = "docs/audits/2026-11-21-fix1416-nomination-rolls.tsv";
export const NOMINATION = "On the Nomination";
export const MERGE_SQL = "SELECT * FROM public.rebuild_entity_connections_votes_full();";

/**
 * Read 4 (cc-309, 2026-11-21 06:57:36Z–06:58:11Z): one GET per roll on a
 * short-numbered stub, through the walk's fetchText, 2.5 s apart. Each
 * <document> as published. All thirteen are PNs with the stub's own number.
 */
export const LIS_DOCUMENTS: Readonly<Record<string, { type: string; number: string }>> = {
  "senate-119-1-00116": { type: "PN", number: "19" },
  "senate-119-1-00117": { type: "PN", number: "19" },
  "senate-119-1-00210": { type: "PN", number: "28" },
  "senate-119-1-00211": { type: "PN", number: "28" },
  "senate-119-1-00230": { type: "PN", number: "20" },
  "senate-119-1-00234": { type: "PN", number: "20" },
  "senate-119-1-00282": { type: "PN", number: "17" },
  "senate-119-1-00283": { type: "PN", number: "17" },
  "senate-119-2-00003": { type: "PN", number: "373" },
  "senate-119-2-00048": { type: "PN", number: "711" },
  "senate-119-2-00049": { type: "PN", number: "711" },
  "senate-119-2-00062": { type: "PN", number: "858" },
  "senate-119-2-00063": { type: "PN", number: "858" },
};

export const MANIFEST_COLUMNS = [
  "roll_call_id",
  "vote_question",
  "voted_at",
  "stub_id",
  "stub_bill_number",
  "pn_id",
  "pn_bill_number",
  "pn_title",
  "vote_rows",
  "basis",
  "action",
] as const;

export type ManifestRow = Record<(typeof MANIFEST_COLUMNS)[number], string>;

/** One appointment proposal numbered `PN <x>`. */
export interface PnRow {
  id: string;
  bill_number: string;
  title: string;
  congress: number | null;
}

/** One candidate stub with every appointment proposal its number names. */
export interface StubRow {
  stub_id: string;
  stub_type: string;
  stub_bill_number: string;
  stub_title: string;
  pns: PnRow[];
}

/** One roll's rows on one proposal (a stub or a PN). */
export interface RollRow {
  proposal_id: string;
  roll_call_id: string;
  chamber: string;
  vote_question: string;
  voted_at: string;
  vote_rows: number;
}

const STUB_NUMBER = /^S (\d+(?:-\d+)?)$/;
const DASHED = /^S \d+-\d+$/;

/** `S 22-17` → `22-17`; null for anything that is not `S <n>` or `S <n>-<m>`. */
export function stubNumber(billNumber: string): string | null {
  return STUB_NUMBER.exec(billNumber)?.[1] ?? null;
}

export const isDashed = (billNumber: string): boolean => DASHED.test(billNumber);

/** `senate-119-1-00440` → 119. */
export function rollCongress(rollCallId: string): number | null {
  const m = /^senate-(\d+)-\d+-\d+$/.exec(rollCallId);
  return m ? Number(m[1]) : null;
}

const cell = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();

/** D2 + D4: why a stub does not qualify, or null when it does. */
export function stubRefusal(stub: StubRow, rolls: readonly RollRow[]): string | null {
  const x = stubNumber(stub.stub_bill_number);
  if (stub.stub_type !== "bill") return `typed ${stub.stub_type}, not bill`;
  if (x === null) return `bill_number ${stub.stub_bill_number} is not S <n> or S <n>-<m>`;
  const own = rolls.filter((r) => r.proposal_id === stub.stub_id);
  if (!own.some((r) => r.chamber === "Senate" && r.vote_question === NOMINATION)) {
    return "no Senate On the Nomination roll";
  }
  if (stub.pns.length === 0) return `no appointment proposal numbered PN ${x}`;
  if (stub.pns.length > 1) return `${stub.pns.length} appointment proposals numbered PN ${x}`;
  const pn = stub.pns[0]!;
  const ownIds = new Set(own.map((r) => r.roll_call_id));
  const shared = rolls.filter((r) => r.proposal_id === pn.id && ownIds.has(r.roll_call_id)).map((r) => r.roll_call_id);
  if (shared.length > 0) return `PN ${x} already carries ${[...new Set(shared)].sort().join(", ")}`;
  return null;
}

/**
 * D3: whether one roll on a qualifying stub moves, and on what basis.
 * `rollTotal` is the roll's row count on every proposal.
 */
export function rollDecision(
  stub: StubRow,
  pn: PnRow,
  roll: RollRow,
  rollTotal: number,
  lis: Readonly<Record<string, { type: string; number: string }>> = LIS_DOCUMENTS,
): { basis: string; action: string } {
  const x = stubNumber(stub.stub_bill_number)!;
  if (roll.chamber !== "Senate" || !roll.roll_call_id.startsWith("senate-")) {
    return { basis: "", action: `skip: not a Senate roll (${roll.chamber})` };
  }
  const congress = rollCongress(roll.roll_call_id);
  if (pn.congress !== null && congress !== pn.congress) {
    return { basis: "", action: `skip: roll congress ${congress} is not the PN's ${pn.congress}` };
  }
  if (rollTotal !== roll.vote_rows) {
    return { basis: "", action: `skip: ${rollTotal - roll.vote_rows} of the roll's rows are on another proposal` };
  }
  if (isDashed(stub.stub_bill_number)) return { basis: "dashed", action: "move" };
  const doc = lis[roll.roll_call_id];
  if (doc) {
    if (doc.type.toUpperCase() === "PN" && doc.number === x) return { basis: `lis PN ${x}`, action: "move" };
    return { basis: `lis ${doc.type} ${doc.number}`, action: "skip: its LIS document is not this PN" };
  }
  if (roll.vote_question === NOMINATION) return { basis: "question", action: "move" };
  return { basis: "", action: "skip: short number, LIS document not read" };
}

/** The manifest: one line per (roll, stub), ordered by stub number then roll. */
export function planManifest(
  stubs: readonly StubRow[],
  rolls: readonly RollRow[],
  rollTotals: ReadonlyMap<string, number>,
  lis: Readonly<Record<string, { type: string; number: string }>> = LIS_DOCUMENTS,
): ManifestRow[] {
  const out: ManifestRow[] = [];
  const sorted = [...stubs].sort((a, b) => a.stub_bill_number.localeCompare(b.stub_bill_number, "en", { numeric: true }));
  for (const stub of sorted) {
    const refusal = stubRefusal(stub, rolls);
    const pn = stub.pns.length === 1 ? stub.pns[0]! : null;
    const own = rolls
      .filter((r) => r.proposal_id === stub.stub_id)
      .sort((a, b) => a.roll_call_id.localeCompare(b.roll_call_id));
    for (const roll of own) {
      const d = refusal !== null || pn === null
        ? { basis: "", action: `skip: ${refusal}` }
        : rollDecision(stub, pn, roll, rollTotals.get(roll.roll_call_id) ?? 0, lis);
      out.push({
        roll_call_id: roll.roll_call_id,
        vote_question: cell(roll.vote_question),
        voted_at: roll.voted_at,
        stub_id: stub.stub_id,
        stub_bill_number: stub.stub_bill_number,
        pn_id: pn?.id ?? "",
        pn_bill_number: pn?.bill_number ?? "",
        pn_title: cell(pn?.title ?? ""),
        vote_rows: String(roll.vote_rows),
        basis: d.basis,
        action: d.action,
      });
    }
  }
  return out;
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

/** What the report quotes: stubs, rolls and vote rows that move, by question, and the skips by reason. */
export function manifestSummary(rows: readonly ManifestRow[]): {
  stubs: number;
  rolls: number;
  vote_rows: number;
  by_question: Record<string, { rolls: number; vote_rows: number }>;
  skipped: Record<string, number>;
} {
  const moves = rows.filter((r) => r.action === "move");
  const by_question: Record<string, { rolls: number; vote_rows: number }> = {};
  for (const r of moves) {
    const q = (by_question[r.vote_question] ??= { rolls: 0, vote_rows: 0 });
    q.rolls++;
    q.vote_rows += Number(r.vote_rows);
  }
  const skipped: Record<string, number> = {};
  for (const r of rows) if (r.action !== "move") skipped[r.action] = (skipped[r.action] ?? 0) + 1;
  return {
    stubs: new Set(moves.map((r) => r.stub_id)).size,
    rolls: moves.length,
    vote_rows: moves.reduce((n, r) => n + Number(r.vote_rows), 0),
    by_question,
    skipped,
  };
}

/** One manifest line's roll as the target holds it now. */
export interface TargetRow {
  on_stub: number;
  on_pn: number;
  on_roll: number;
  stub_bill_number: string | null;
  pn_type: string | null;
  pn_bill_number: string | null;
}

/** D5: `move`, `already` (on its PN at the manifest's count), or a throw that aborts the transaction. */
export function checkTarget(m: ManifestRow, t: TargetRow): "move" | "already" {
  const n = Number(m.vote_rows);
  const at = `${m.roll_call_id} (${m.stub_bill_number} → ${m.pn_bill_number})`;
  if (t.pn_type !== "appointment" || t.pn_bill_number !== m.pn_bill_number) {
    throw new Error(`${at}: PN proposal ${m.pn_id} is ${t.pn_type ?? "missing"} ${t.pn_bill_number ?? ""}, not appointment ${m.pn_bill_number}`);
  }
  if (t.on_stub === n && t.on_pn === 0 && t.on_roll === n) {
    if (t.stub_bill_number !== m.stub_bill_number) {
      throw new Error(`${at}: stub ${m.stub_id} is numbered ${t.stub_bill_number ?? "(missing)"} here`);
    }
    return "move";
  }
  if (t.on_stub === 0 && t.on_pn === n && t.on_roll === n) return "already";
  throw new Error(`${at}: manifest ${n} rows on the stub; target ${t.on_stub} on the stub, ${t.on_pn} on the PN, ${t.on_roll} on the roll`);
}

type Q = Pick<Client, "query">;

/** The candidates on the target: stubs (with every PN their number names), their rolls and their PNs' rolls, each roll's total. */
export async function readTarget(client: Q): Promise<{ stubs: StubRow[]; rolls: RollRow[]; rollTotals: Map<string, number> }> {
  const s = await client.query<{ stub_id: string; stub_type: string; stub_bill_number: string; stub_title: string; pns: PnRow[] }>(
    `WITH stub AS MATERIALIZED (
       SELECT p.id, p.type::text AS type, p.title, bd.bill_number
         FROM public.proposals p
         JOIN public.bill_details bd ON bd.proposal_id = p.id
        WHERE p.type = 'bill' AND bd.bill_number LIKE 'S %'
          AND EXISTS (SELECT 1 FROM public.votes v
                       WHERE v.bill_proposal_id = p.id AND v.chamber = 'Senate' AND v.vote_question = $1)
     )
     SELECT s.id AS stub_id, s.type AS stub_type, s.bill_number AS stub_bill_number, s.title AS stub_title,
            coalesce(json_agg(json_build_object('id', a.id, 'bill_number', abd.bill_number, 'title', a.title,
                                                'congress', abd.congress_number) ORDER BY a.id)
                     FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS pns
       FROM stub s
       LEFT JOIN public.bill_details abd ON abd.bill_number = 'PN ' || substr(s.bill_number, 3)
       LEFT JOIN public.proposals a ON a.id = abd.proposal_id AND a.type = 'appointment'
      GROUP BY s.id, s.type, s.bill_number, s.title`,
    [NOMINATION],
  );
  const stubs = s.rows;
  const ids = [...new Set(stubs.flatMap((r) => [r.stub_id, ...r.pns.map((p) => p.id)]))];
  const r = await client.query<{ proposal_id: string; roll_call_id: string; chamber: string; vote_question: string | null; voted_at: Date; vote_rows: number }>(
    `SELECT v.bill_proposal_id AS proposal_id, v.roll_call_id, v.chamber, v.vote_question,
            min(v.voted_at) AS voted_at, count(*)::int AS vote_rows
       FROM public.votes v
      WHERE v.bill_proposal_id = ANY($1::uuid[])
      GROUP BY 1, 2, 3, 4`,
    [ids],
  );
  const rolls = r.rows.map((x) => ({ ...x, vote_question: x.vote_question ?? "", voted_at: x.voted_at.toISOString() }));
  const t = await client.query<{ roll_call_id: string; n: number }>(
    "SELECT roll_call_id, count(*)::int AS n FROM public.votes WHERE roll_call_id = ANY($1::text[]) GROUP BY 1",
    [[...new Set(rolls.map((x) => x.roll_call_id))]],
  );
  return { stubs, rolls, rollTotals: new Map(t.rows.map((x) => [x.roll_call_id, x.n])) };
}

/** The manifest's rolls as the target holds them, in manifest order. */
async function readManifestTarget(client: Q, moves: readonly ManifestRow[]): Promise<TargetRow[]> {
  const res = await client.query<TargetRow & { ord: string }>(
    `SELECT m.ord,
            (SELECT count(*)::int FROM public.votes v WHERE v.roll_call_id = m.roll AND v.bill_proposal_id = m.stub) AS on_stub,
            (SELECT count(*)::int FROM public.votes v WHERE v.roll_call_id = m.roll AND v.bill_proposal_id = m.pn) AS on_pn,
            (SELECT count(*)::int FROM public.votes v WHERE v.roll_call_id = m.roll) AS on_roll,
            sbd.bill_number AS stub_bill_number, p.type::text AS pn_type, pbd.bill_number AS pn_bill_number
       FROM unnest($1::text[], $2::uuid[], $3::uuid[]) WITH ORDINALITY AS m(roll, stub, pn, ord)
       LEFT JOIN public.bill_details sbd ON sbd.proposal_id = m.stub
       LEFT JOIN public.proposals p ON p.id = m.pn
       LEFT JOIN public.bill_details pbd ON pbd.proposal_id = m.pn
      ORDER BY m.ord`,
    [moves.map((m) => m.roll_call_id), moves.map((m) => m.stub_id), moves.map((m) => m.pn_id)],
  );
  return res.rows;
}

/** Rows and vote edges on the manifest's stubs and PNs: the before / after line. */
export async function standing(client: Q, rows: readonly ManifestRow[]): Promise<Record<string, number>> {
  const stubs = [...new Set(rows.map((r) => r.stub_id))];
  const pns = [...new Set(rows.map((r) => r.pn_id).filter((x) => x !== ""))];
  const res = await client.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM public.votes WHERE bill_proposal_id = ANY($1::uuid[])) AS rows_on_stubs,
            (SELECT count(*)::int FROM public.votes WHERE bill_proposal_id = ANY($2::uuid[])) AS rows_on_pns,
            (SELECT count(*)::int FROM public.entity_connections
              WHERE to_id = ANY($1::uuid[]) AND connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')) AS edges_on_stubs,
            (SELECT count(*)::int FROM public.entity_connections
              WHERE to_id = ANY($2::uuid[]) AND connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')) AS edges_on_pns,
            (SELECT count(*)::int FROM public.proposals WHERE id = ANY($1::uuid[])) AS stubs`,
    [stubs, pns],
  );
  return res.rows[0]!;
}

/**
 * The re-point, inside the caller's transaction: every `move` line re-verified
 * (D5), then one UPDATE for the lot. Returns rows moved and rolls already done.
 */
export async function repoint(client: Q, manifest: readonly ManifestRow[]): Promise<{ moved_rows: number; moved_rolls: number; already: number }> {
  const moves = manifest.filter((m) => m.action === "move");
  const target = await readManifestTarget(client, moves);
  const todo: ManifestRow[] = [];
  let already = 0;
  moves.forEach((m, i) => {
    if (checkTarget(m, target[i]!) === "move") todo.push(m);
    else already++;
  });
  if (todo.length === 0) return { moved_rows: 0, moved_rolls: 0, already };
  const res = await client.query<{ roll_call_id: string; n: number }>(
    `WITH u AS (
       UPDATE public.votes v SET bill_proposal_id = m.pn
         FROM unnest($1::text[], $2::uuid[], $3::uuid[]) AS m(roll, stub, pn)
        WHERE v.roll_call_id = m.roll AND v.bill_proposal_id = m.stub
       RETURNING v.roll_call_id
     )
     SELECT roll_call_id, count(*)::int AS n FROM u GROUP BY 1`,
    [todo.map((m) => m.roll_call_id), todo.map((m) => m.stub_id), todo.map((m) => m.pn_id)],
  );
  const got = new Map(res.rows.map((r) => [r.roll_call_id, r.n]));
  for (const m of todo) {
    if (got.get(m.roll_call_id) !== Number(m.vote_rows)) {
      throw new Error(`${m.roll_call_id}: the UPDATE moved ${got.get(m.roll_call_id) ?? 0} rows, the manifest says ${m.vote_rows}`);
    }
  }
  return { moved_rows: [...got.values()].reduce((a, b) => a + b, 0), moved_rolls: todo.length, already };
}

/**
 * Every (relation.column) holding each id, over every uuid / uuid[] column of
 * public's tables and materialized views — the stub's own proposals.id and
 * bill_details.proposal_id aside. By value, not by name (cc-309 read 2):
 * entity_search_index.entity_id and the like hold proposal ids with no FK.
 */
export async function referencesTo(client: Q, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const cols = await client.query<{ rel: string; col: string; arr: boolean }>(
    `SELECT c.relname AS rel, a.attname AS col, a.atttypid = 'uuid[]'::regtype AS arr
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'm')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.atttypid IN ('uuid'::regtype, 'uuid[]'::regtype)
        AND (c.relname, a.attname) NOT IN (('proposals', 'id'), ('bill_details', 'proposal_id'))
      ORDER BY 1, 2`,
  );
  for (const { rel, col, arr } of cols.rows) {
    const q = arr
      ? `SELECT x::text AS id, count(*)::int AS n FROM public.%R, unnest(%C) AS x WHERE %C && $1::uuid[] AND x = ANY($1::uuid[]) GROUP BY 1`
      : `SELECT %C::text AS id, count(*)::int AS n FROM public.%R WHERE %C = ANY($1::uuid[]) GROUP BY 1`;
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const res = await client.query<{ id: string; n: number }>(q.replace(/%R/g, ident(rel)).replace(/%C/g, ident(col)), [ids]);
    for (const r of res.rows) out.get(r.id)?.push(`${rel}.${col} ${r.n}`);
  }
  return out;
}

/**
 * D7, inside the caller's transaction: each dashed `move` stub whose title is
 * its number and which nothing points at is deleted with its bill_details row.
 * The rest are refused with what still points at them.
 */
export async function retireStubs(client: Q, manifest: readonly ManifestRow[]): Promise<{
  retired: string[];
  refused: Array<{ stub_id: string; stub_bill_number: string; why: string[] }>;
}> {
  const byStub = new Map<string, string>();
  for (const m of manifest) if (m.action === "move" && isDashed(m.stub_bill_number)) byStub.set(m.stub_id, m.stub_bill_number);
  const ids = [...byStub.keys()];
  const rows = await client.query<{ id: string; type: string; title: string; bill_number: string | null }>(
    `SELECT p.id, p.type::text AS type, p.title, bd.bill_number
       FROM public.proposals p LEFT JOIN public.bill_details bd ON bd.proposal_id = p.id
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  const state = new Map(rows.rows.map((r) => [r.id, r]));
  const refs = await referencesTo(client, ids);
  const retire: string[] = [];
  const refused: Array<{ stub_id: string; stub_bill_number: string; why: string[] }> = [];
  for (const [id, number] of byStub) {
    const s = state.get(id);
    const why: string[] = [];
    if (!s) why.push("no proposals row");
    else {
      if (s.type !== "bill") why.push(`typed ${s.type}`);
      if (s.bill_number !== number) why.push(`numbered ${s.bill_number ?? "(no bill_details)"}`);
      if (s.title !== number) why.push("title is not its number");
    }
    why.push(...(refs.get(id) ?? []));
    if (why.length === 0) retire.push(id);
    else refused.push({ stub_id: id, stub_bill_number: number, why });
  }
  if (retire.length > 0) {
    const bd = await client.query("DELETE FROM public.bill_details WHERE proposal_id = ANY($1::uuid[])", [retire]);
    const p = await client.query("DELETE FROM public.proposals WHERE id = ANY($1::uuid[]) AND type = 'bill'", [retire]);
    if (bd.rowCount !== retire.length || p.rowCount !== retire.length) {
      throw new Error(`retire: ${retire.length} stubs, deleted ${bd.rowCount} bill_details and ${p.rowCount} proposals`);
    }
  }
  return { retired: retire, refused };
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
  // --manifest may be absolute (a clone-built draft goes to a scratch dir, never docs/audits).
  const manifestPath = resolve(repoRoot("fix1416"), argValue(argv, "--manifest") ?? DEFAULT_MANIFEST);
  const apply = argv.includes("--apply");
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: dsn });
  await client.connect();
  try {
    console.info(`[fix1416] target ${local ? "LOCAL" : "PROD"}`);

    if (argv.includes("--build")) {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const t0 = Date.now();
      const { stubs, rolls, rollTotals } = await readTarget(client);
      const manifest = planManifest(stubs, rolls, rollTotals);
      console.info(`[fix1416] read ${stubs.length} candidate stubs, ${rolls.length} (proposal, roll) pairs in ${Date.now() - t0} ms`);
      console.info(`[fix1416] standing: ${JSON.stringify(await standing(client, manifest))}`);
      await client.query("ROLLBACK");
      writeFileSync(manifestPath, toTsv(manifest), "utf8");
      console.info(`[fix1416] wrote ${manifest.length} lines → ${manifestPath}`);
      console.info(`[fix1416] manifest: ${JSON.stringify(manifestSummary(manifest))}`);
      return;
    }

    const manifest = parseTsv(readFileSync(manifestPath, "utf8"));
    console.info(`[fix1416] manifest ${manifestPath}: ${JSON.stringify(manifestSummary(manifest))}`);

    if (argv.includes("--retire-stubs")) {
      await client.query("SET statement_timeout = '5min'");
      await client.query("BEGIN");
      const before = await standing(client, manifest);
      const r = await retireStubs(client, manifest);
      for (const x of r.refused) console.info(`[fix1416] refused ${x.stub_bill_number} ${x.stub_id}: ${x.why.join("; ")}`);
      const after = await standing(client, manifest);
      await client.query(apply ? "COMMIT" : "ROLLBACK");
      console.info(`[fix1416] ${apply ? "APPLIED" : "DRY RUN (rolled back)"}: retired ${r.retired.length}, refused ${r.refused.length}`);
      console.info(`[fix1416] before: ${JSON.stringify(before)}`);
      console.info(`[fix1416] after${apply ? "" : " (would be)"}: ${JSON.stringify(after)}`);
      return;
    }

    await client.query("SET statement_timeout = '60s'");
    await client.query("BEGIN");
    const before = await standing(client, manifest);
    const t0 = Date.now();
    const r = await repoint(client, manifest);
    const wall = Date.now() - t0;
    const after = await standing(client, manifest);
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.info(`[fix1416] ${apply ? "APPLIED" : "DRY RUN (rolled back)"}: ${r.moved_rows} rows on ${r.moved_rolls} rolls moved, ${r.already} rolls already on their PN, ${wall} ms`);
    console.info(`[fix1416] before: ${JSON.stringify(before)}`);
    console.info(`[fix1416] after${apply ? "" : " (would be)"}: ${JSON.stringify(after)}`);
    if (!apply) console.info(`[fix1416] after (actual): ${JSON.stringify(await standing(client, manifest))}`);
    console.info(`[fix1416] the edges follow by the merge, once, under its own claim: ${MERGE_SQL}`);
    console.info(`[fix1416]   expect deleted ≈ ${before["edges_on_stubs"]} (the stubs' vote edges) and inserted ≈ as many on the PNs, beside whatever drift the merge finds elsewhere`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* no transaction open */ });
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[fix1416] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
