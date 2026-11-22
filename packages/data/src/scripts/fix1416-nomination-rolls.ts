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
 *                      hold) whose title is its number and which no `block`
 *                      holder holds (HOLDERS, cc-310 D5: the foreign keys read
 *                      from pg_constraint at run time, and the typed pairs).
 *                      Its `clear` rows (source refs, tags, search row) and
 *                      its bill_details row go with it. Runs AFTER the
 *                      re-point and the votes merge. DRY unless `--apply`.
 *   --census           LOCAL only: every uuid / uuid[] column in public, and
 *                      every text id beside a type column, read by value for
 *                      the manifest's stubs and PNs. Finds holders; writes
 *                      nothing. --retire-stubs never runs it.
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
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local src/scripts/fix1416-nomination-rolls.ts --census
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
 * D5 (cc-310): what holds a stub, by kind. Every read is by the proposal's
 * (type, id), never a bare `entity_id = ANY(…)`:
 *   block  any row refuses the stub;
 *   clear  deleted with the stub, counted per relation;
 *   leave  derived, reconciled by its owner: read and printed, not written;
 *   keep   history: read and printed, not written.
 * The foreign keys into proposals / bill_details are `block` too, read from
 * pg_constraint at run time (foreignKeyHolders): a CASCADE one would otherwise
 * delete rows silently.
 */
export type HolderKind = "block" | "clear" | "leave" | "keep";

export interface Holder {
  kind: HolderKind;
  rel: string;
  idCol: string;
  /** The sibling type column and the value a proposal is stored under; null for a relation keyed by the proposal alone (a leave, or an FK). */
  type: { col: string; value: string } | null;
  /** The id column is text, so ids are compared as text. */
  text?: boolean;
  why: string;
}

/**
 * The typed pairs (cc-310 read 2 on the clone): every relation whose type
 * column stores 'proposal', with data_flags beside them (its CHECK admits
 * 'proposal'). enrichment_queue keys a TEXT entity_id, so cc-309's uuid sweep
 * could not see it; it holds every dashed stub (one tag task each).
 */
export const TYPED_HOLDERS: readonly Holder[] = [
  { kind: "clear", rel: "external_source_refs", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "the stub's 119-S-<n>-<m> source refs; the walk now mints 119-PN-<n>" },
  { kind: "clear", rel: "entity_tags", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "the tagger's rows for the stub" },
  { kind: "clear", rel: "entity_search_index", idCol: "entity_id", type: { col: "kind", value: "proposal" }, why: "the stub's search row (rebuild_entity_search_index rebuilds it daily anyway)" },
  { kind: "leave", rel: "entity_connection_stats_mv", idCol: "entity_id", type: null, why: "rebuild_entity_connection_stats_window() deletes the row of an entity with no edge in its window" },
  { kind: "leave", rel: "proposal_trending_24h", idCol: "proposal_id", type: null, why: "refresh_derived_mvs('daily') refreshes it in full" },
  { kind: "keep", rel: "page_views", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "history" },
  { kind: "block", rel: "entity_connections", idCol: "from_id", type: { col: "from_type", value: "proposal" }, why: "an edge from the stub" },
  { kind: "block", rel: "entity_connections", idCol: "to_id", type: { col: "to_type", value: "proposal" }, why: "an edge to the stub (the votes merge retires its vote edges)" },
  { kind: "block", rel: "enrichment_queue", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, text: true, why: "an enrichment task (text entity_id)" },
  { kind: "block", rel: "ai_summary_cache", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "an AI summary" },
  { kind: "block", rel: "commons_active_threads", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a comment thread (MV)" },
  { kind: "block", rel: "data_flags", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a data flag (its CHECK admits proposal)" },
  { kind: "block", rel: "entity_activity_state", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "activity state" },
  { kind: "block", rel: "entity_comments", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a comment" },
  { kind: "block", rel: "entity_positions", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a position" },
  { kind: "block", rel: "entity_statements", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a statement" },
  { kind: "block", rel: "investigations", idCol: "scope_id", type: { col: "scope_type", value: "proposal" }, why: "an investigation's scope" },
  { kind: "block", rel: "position_events", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a position event" },
  { kind: "block", rel: "synthetic_position_rollup", idCol: "entity_id", type: { col: "entity_type", value: "proposal" }, why: "a synthetic position rollup" },
];

export const holderLabel = (h: Holder): string => `${h.rel}.${h.idCol}`;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

function holderWhere(h: Holder): string {
  const id = `${ident(h.idCol)} = ANY($1::${h.text ? "text" : "uuid"}[])`;
  return h.type ? `${ident(h.type.col)} = ${literal(h.type.value)} AND ${id}` : id;
}

/** The count one holder holds per id, by (type, id). */
export const holderSql = (h: Holder): string =>
  `SELECT ${ident(h.idCol)}::text AS id, count(*)::int AS n FROM public.${ident(h.rel)} WHERE ${holderWhere(h)} GROUP BY 1`;

/** A `clear` holder's delete, by the same (type, id) as its read. */
export function clearSql(h: Holder): string {
  if (h.kind !== "clear") throw new Error(`${holderLabel(h)} is ${h.kind}, not clear`);
  return `DELETE FROM public.${ident(h.rel)} WHERE ${holderWhere(h)}`;
}

/** Every foreign key into proposals / bill_details but bill_details' own, as a `block` holder, read now. */
export async function foreignKeyHolders(client: Q): Promise<Holder[]> {
  const res = await client.query<{ nsp: string; rel: string; col: string; target: string; target_col: string; on_delete: string; ncols: number }>(
    `SELECT n.nspname AS nsp, c.relname AS rel, a.attname AS col, tc.relname AS target, fa.attname AS target_col,
            CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                                 WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
            cardinality(con.conkey) AS ncols
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class tc ON tc.oid = con.confrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND con.confrelid IN ('public.proposals'::regclass, 'public.bill_details'::regclass)
      ORDER BY 2, 3`,
  );
  return res.rows
    .filter((f) => !(f.nsp === "public" && f.rel === "bill_details" && f.col === "proposal_id"))
    .map((f) => {
      const keyed = (f.target === "proposals" && f.target_col === "id") || (f.target === "bill_details" && f.target_col === "proposal_id");
      if (f.nsp !== "public" || f.ncols !== 1 || !keyed) {
        throw new Error(`foreign key ${f.nsp}.${f.rel}.${f.col} → ${f.target}(${f.target_col}) (${f.ncols} columns) is not one this retire can read`);
      }
      return { kind: "block" as const, rel: f.rel, idCol: f.col, type: null, why: `FK → ${f.target}(${f.target_col}) ON DELETE ${f.on_delete}` };
    });
}

/** The dashed `move` stubs: the only ones the retire considers. A short stub (`S 858` is also a real bill) never is. */
export function retireCandidates(manifest: readonly ManifestRow[]): Array<{ stub_id: string; stub_bill_number: string }> {
  const byStub = new Map<string, string>();
  for (const m of manifest) if (m.action === "move" && isDashed(m.stub_bill_number)) byStub.set(m.stub_id, m.stub_bill_number);
  return [...byStub].map(([stub_id, stub_bill_number]) => ({ stub_id, stub_bill_number }));
}

export interface HolderCount {
  holder: Holder;
  byId: ReadonlyMap<string, number>;
}

export interface Refusal {
  stub_id: string;
  stub_bill_number: string;
  why: string[];
}

/** D5: retired only when typed bill, numbered and titled as the manifest says, and every `block` count is 0. */
export function retireDecision(
  candidates: ReadonlyArray<{ stub_id: string; stub_bill_number: string }>,
  state: ReadonlyMap<string, { type: string; title: string; bill_number: string | null }>,
  counts: readonly HolderCount[],
): { retire: string[]; refused: Refusal[] } {
  const retire: string[] = [];
  const refused: Refusal[] = [];
  for (const { stub_id, stub_bill_number } of candidates) {
    const s = state.get(stub_id);
    const why: string[] = [];
    if (!s) why.push("no proposals row");
    else {
      if (s.type !== "bill") why.push(`typed ${s.type}`);
      if (s.bill_number !== stub_bill_number) why.push(`numbered ${s.bill_number ?? "(no bill_details)"}`);
      if (s.title !== stub_bill_number) why.push("title is not its number");
    }
    for (const c of counts) {
      const n = c.byId.get(stub_id) ?? 0;
      if (c.holder.kind === "block" && n > 0) why.push(`${holderLabel(c.holder)} ${n}`);
    }
    if (why.length === 0) retire.push(stub_id);
    else refused.push({ stub_id, stub_bill_number, why });
  }
  return { retire, refused };
}

/** One printed line per holder: kind, relation, why, and what it holds of the candidates (and of the retired). */
export function holderLines(counts: readonly HolderCount[], retired: readonly string[]): string[] {
  const kept = new Set(retired);
  const order: HolderKind[] = ["block", "clear", "leave", "keep"];
  return [...counts]
    .sort((a, b) => order.indexOf(a.holder.kind) - order.indexOf(b.holder.kind) || holderLabel(a.holder).localeCompare(holderLabel(b.holder)))
    .map((c) => {
      const ids = [...c.byId.keys()];
      const rows = [...c.byId.values()].reduce((a, b) => a + b, 0);
      const ofRetired = ids.filter((id) => kept.has(id)).reduce((a, id) => a + c.byId.get(id)!, 0);
      const t = c.holder.type ? ` [${c.holder.type.col} = '${c.holder.type.value}'${c.holder.text ? ", text id" : ""}]` : "";
      return `${c.holder.kind.padEnd(5)} ${holderLabel(c.holder)}${t}: stubs ${ids.length}, rows ${rows}, of the retired ${ofRetired} — ${c.holder.why}`;
    });
}

/** Each holder read's plan, scan nodes only (EXPLAIN, no ANALYZE), and whether it sequential-scans a relation over `maxPages`. */
export async function explainHolders(client: Q, holders: readonly Holder[], ids: readonly string[], maxPages = 1000): Promise<Array<{ label: string; nodes: string[]; heavy: string[] }>> {
  const out: Array<{ label: string; nodes: string[]; heavy: string[] }> = [];
  for (const h of holders) {
    const res = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${holderSql(h)}`, [ids]);
    const nodes: string[] = [];
    const seq: string[] = [];
    const walk = (p: PlanNode) => {
      if (/Scan/.test(p["Node Type"])) {
        nodes.push(`${p["Node Type"]}${p["Index Name"] ? ` using ${p["Index Name"]}` : ""}${p["Relation Name"] ? ` on ${p["Relation Name"]}` : ""}`);
        if (p["Node Type"] === "Seq Scan" && p["Relation Name"]) seq.push(p["Relation Name"]);
      }
      for (const k of p.Plans ?? []) walk(k);
    };
    walk(res.rows[0]!["QUERY PLAN"][0]!.Plan);
    const heavy: string[] = [];
    for (const rel of seq) {
      const pages = (await client.query<{ n: number }>("SELECT relpages::int AS n FROM pg_class WHERE oid = $1::regclass", [`public.${ident(rel)}`])).rows[0]?.n ?? 0;
      if (pages > maxPages) heavy.push(`${rel} (${pages} pages)`);
    }
    out.push({ label: holderLabel(h), nodes, heavy });
  }
  return out;
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

export interface RetireResult {
  retired: string[];
  refused: Refusal[];
  counts: HolderCount[];
  cleared: Record<string, number>;
  plans: Array<{ label: string; nodes: string[]; heavy: string[] }>;
}

/**
 * D7, inside the caller's transaction: the plans (a read that would
 * sequential-scan a relation over 1,000 pages aborts before any read), the
 * holders' counts, the decision, then each `clear` relation's delete, then
 * bill_details, then proposals (`type = 'bill'`). Every delete is asserted
 * against the retired stubs; a mismatch throws and the caller rolls back.
 */
export async function retireStubs(client: Q, manifest: readonly ManifestRow[]): Promise<RetireResult> {
  const candidates = retireCandidates(manifest);
  const ids = candidates.map((c) => c.stub_id);
  const holders = [...(await foreignKeyHolders(client)), ...TYPED_HOLDERS];
  const plans = await explainHolders(client, holders, ids);
  const heavy = plans.filter((p) => p.heavy.length > 0);
  if (heavy.length > 0) {
    throw new Error(`retire: these reads would sequential-scan a large relation; run --census on the clone instead: ${heavy.map((p) => `${p.label} → ${p.heavy.join(", ")}`).join("; ")}`);
  }
  const rows = await client.query<{ id: string; type: string; title: string; bill_number: string | null }>(
    `SELECT p.id, p.type::text AS type, p.title, bd.bill_number
       FROM public.proposals p LEFT JOIN public.bill_details bd ON bd.proposal_id = p.id
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  const state = new Map(rows.rows.map((r) => [r.id, r]));
  const counts: HolderCount[] = [];
  for (const h of holders) {
    const res = await client.query<{ id: string; n: number }>(holderSql(h), [ids]);
    counts.push({ holder: h, byId: new Map(res.rows.map((r) => [r.id, r.n])) });
  }
  const { retire, refused } = retireDecision(candidates, state, counts);
  const cleared: Record<string, number> = {};
  if (retire.length > 0) {
    for (const c of counts.filter((x) => x.holder.kind === "clear")) {
      const want = retire.reduce((a, id) => a + (c.byId.get(id) ?? 0), 0);
      const del = await client.query(clearSql(c.holder), [retire]);
      if (del.rowCount !== want) throw new Error(`retire: ${holderLabel(c.holder)} read ${want} rows for the retired stubs, deleted ${del.rowCount}`);
      cleared[holderLabel(c.holder)] = want;
    }
    const bd = await client.query("DELETE FROM public.bill_details WHERE proposal_id = ANY($1::uuid[])", [retire]);
    const p = await client.query("DELETE FROM public.proposals WHERE id = ANY($1::uuid[]) AND type = 'bill'", [retire]);
    if (bd.rowCount !== retire.length || p.rowCount !== retire.length) {
      throw new Error(`retire: ${retire.length} stubs, deleted ${bd.rowCount} bill_details and ${p.rowCount} proposals`);
    }
    cleared["bill_details.proposal_id"] = bd.rowCount;
    cleared["proposals.id"] = p.rowCount;
  }
  return { retired: retire, refused, counts, cleared, plans };
}

export interface CensusRow {
  column: string;
  stubs: number;
  stub_rows: number;
  pns: number;
  pn_rows: number;
}

/**
 * D6: the by-value census, LOCAL only (main refuses it elsewhere). Every uuid
 * / uuid[] column of public's tables and MVs, and every text `<x>id` column
 * with a `<x>type` beside it (enrichment_queue.entity_id), read for the stubs
 * and the PNs. Run it once to find holders; the retire checks HOLDERS. It is
 * minutes on the clone (cc-309: 145 s cold), so it is never part of a retire.
 */
export async function census(client: Q, stubs: readonly string[], pns: readonly string[]): Promise<CensusRow[]> {
  const cols = await client.query<{ rel: string; col: string; kind: "uuid" | "uuid[]" | "text" }>(
    `SELECT c.relname AS rel, a.attname AS col,
            CASE a.atttypid WHEN 'uuid'::regtype THEN 'uuid' WHEN 'uuid[]'::regtype THEN 'uuid[]' ELSE 'text' END AS kind
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'm')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.atttypid IN ('uuid'::regtype, 'uuid[]'::regtype)
             OR (a.atttypid = 'text'::regtype AND a.attname LIKE '%id'
                 AND EXISTS (SELECT 1 FROM pg_attribute t
                              WHERE t.attrelid = a.attrelid AND t.attnum > 0 AND NOT t.attisdropped
                                AND t.attname = left(a.attname, length(a.attname) - 2) || 'type')))
      ORDER BY 1, 2`,
  );
  const out: CensusRow[] = [];
  for (const { rel, col, kind } of cols.rows) {
    const x = kind === "uuid[]" ? "x" : ident(col);
    const from = kind === "uuid[]" ? `public.${ident(rel)}, unnest(${ident(col)}) AS x` : `public.${ident(rel)}`;
    const t = kind === "text" ? "text" : "uuid";
    const where = kind === "uuid[]" ? `${ident(col)} && ($1::uuid[] || $2::uuid[])` : `${x} = ANY($1::${t}[] || $2::${t}[])`;
    const res = await client.query<{ stubs: number; stub_rows: number; pns: number; pn_rows: number }>(
      `SELECT count(DISTINCT ${x}) FILTER (WHERE ${x} = ANY($1::${t}[]))::int AS stubs,
              count(*) FILTER (WHERE ${x} = ANY($1::${t}[]))::int AS stub_rows,
              count(DISTINCT ${x}) FILTER (WHERE ${x} = ANY($2::${t}[]))::int AS pns,
              count(*) FILTER (WHERE ${x} = ANY($2::${t}[]))::int AS pn_rows
         FROM ${from} WHERE ${where}`,
      [stubs, pns],
    );
    const r = res.rows[0]!;
    if (r.stub_rows + r.pn_rows > 0) out.push({ column: `${rel}.${col}${kind === "text" ? " (text)" : ""}`, ...r });
  }
  return out;
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

/** LOCAL or PROD, or a throw: --census is LOCAL only, --allow-prod or not; anything else needs --allow-prod off LOCAL. */
export function targetOf(dsn: string, argv: readonly string[]): "LOCAL" | "PROD" {
  const local = dsn.includes("127.0.0.1") || dsn.includes("localhost");
  if (argv.includes("--census") && !local) {
    throw new Error("--census reads every uuid column by value: LOCAL only, with or without --allow-prod");
  }
  if (!local && !argv.includes("--allow-prod")) {
    throw new Error("refusing a non-local database without --allow-prod");
  }
  return local ? "LOCAL" : "PROD";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dsn = buildDbUrl();
  const target = targetOf(dsn, argv);
  // --manifest may be absolute (a clone-built draft goes to a scratch dir, never docs/audits).
  const manifestPath = resolve(repoRoot("fix1416"), argValue(argv, "--manifest") ?? DEFAULT_MANIFEST);
  const apply = argv.includes("--apply");
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: dsn });
  await client.connect();
  try {
    console.info(`[fix1416] target ${target}`);

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

    if (argv.includes("--census")) {
      const stubs = [...new Set(manifest.filter((m) => m.action === "move").map((m) => m.stub_id))];
      const pns = [...new Set(manifest.filter((m) => m.action === "move").map((m) => m.pn_id))];
      await client.query("BEGIN READ ONLY");
      const t0 = Date.now();
      const rows = await census(client, stubs, pns);
      await client.query("ROLLBACK");
      console.info(`[fix1416] census of ${stubs.length} stubs and ${pns.length} PNs by value, ${Date.now() - t0} ms (writes nothing):`);
      for (const r of rows) console.info(`[fix1416]   ${r.column}: stubs ${r.stubs} / ${r.stub_rows} rows · PNs ${r.pns} / ${r.pn_rows} rows`);
      return;
    }

    if (argv.includes("--retire-stubs")) {
      await client.query("SET statement_timeout = '60s'");
      await client.query("BEGIN");
      const before = await standing(client, manifest);
      const t0 = Date.now();
      const r = await retireStubs(client, manifest);
      const wall = Date.now() - t0;
      console.info(`[fix1416] holders (block / clear / leave / keep), over ${retireCandidates(manifest).length} dashed stubs:`);
      for (const line of holderLines(r.counts, r.retired)) console.info(`[fix1416]   ${line}`);
      for (const p of r.plans) console.info(`[fix1416]   plan ${p.label}: ${p.nodes.join(" → ")}`);
      for (const x of r.refused) console.info(`[fix1416] refused ${x.stub_bill_number} ${x.stub_id}: ${x.why.join("; ")}`);
      const after = await standing(client, manifest);
      await client.query(apply ? "COMMIT" : "ROLLBACK");
      console.info(`[fix1416] ${apply ? "APPLIED" : "DRY RUN (rolled back)"}: retired ${r.retired.length}, refused ${r.refused.length}, ${wall} ms`);
      console.info(`[fix1416] deleted: ${JSON.stringify(r.cleared)}`);
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
