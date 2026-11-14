/**
 * FIX-1407 — the Senate rolls the nightly has fetched, parsed, and could not
 * store: one `pipeline_state` row per Congress, so the next night's walk skips
 * them instead of asking senate.gov for them again.
 *
 * Wed 11-11's nightly (run 43100066678) fetched 163 Senate rolls and stored 2.
 * The other 161 parsed fine and carried no bill reference (session 1: 118 of
 * 118; session 2: 43 of 45), so they never reached `votes`, were never in the
 * pre-loaded stored set, and were fetched again every night — ahead of the new
 * rolls at the end of the session, on a feed that 403s after a few dozen GETs.
 *
 *   key    congress_votes:senate_rolls:<congress>
 *   value  { v, sessions: { "<n>": { tail_closed, rolls: { <roll_call_id>:
 *            { reason, seen_at } } } } }
 *
 * - `no_proposal_reference` and `no_voted_at` belong to the roll under today's
 *   parser: skipped for as long as `v` equals SENATE_UNSTORED_VERSION. Bump the
 *   constant when the parser learns to store such a roll (a new document type,
 *   the nomination stage): a record of another version is dropped whole, its
 *   `tail_closed` flags with it, and every roll is fetched again once.
 * - Every other reason can change without a code change (a bill_details row
 *   lands, a member map is fixed, a resolve that failed succeeds): skipped for
 *   RETRY_ABSENT_DAYS after `seen_at`, then fetched again.
 * - An insert failure is never recorded, nor is a blocked, transient or
 *   past-the-end answer — only a roll that parsed and was skipped before its
 *   insert (`writeRollVotes`' `unstored`).
 * - `tail_closed` (D3): a past year's session whose tail walk ended past the
 *   end with no blocked or transient roll in it. Later runs skip its tail.
 *
 * Deleting the row is harmless: the next run fetches everything once, as
 * before FIX-1407. `pipeline_state` is world-readable (its public SELECT
 * policy), so the value holds roll ids, reasons, dates and flags — nothing else.
 */

import type { RollProbeSummary } from "./roll-probe";
import type { UnstoredReason } from "./vote-bill-guard";

/** Bump when the parser learns to store a roll it skips today. */
export const SENATE_UNSTORED_VERSION = 1;

/** A roll skipped for a reason that can clear by itself is fetched again after this many days. */
export const RETRY_ABSENT_DAYS = 7;

/** The Senate's pacing between GETs (FIX-1407 D5). */
export const SENATE_PACE_MS = { base: 1500, jitter: 500 } as const;

/** Reasons that are the roll's own under today's parser. */
const PARSER_REASONS: ReadonlySet<UnstoredReason> = new Set<UnstoredReason>(["no_proposal_reference", "no_voted_at"]);

const REASONS: ReadonlySet<string> = new Set<UnstoredReason>([
  "no_proposal_reference",
  "bill_unresolved",
  "no_voted_at",
  "bill_details_key_collision",
  "bill_details_landing_failed",
  "no_matchable_records",
]);

export function senateUnstoredKey(congress: number): string {
  return `congress_votes:senate_rolls:${congress}`;
}

export interface UnstoredRoll {
  reason: UnstoredReason;
  /** YYYY-MM-DD (UTC): the last run that fetched the roll and could not store it. */
  seen_at: string;
}

export interface SenateUnstoredSession {
  tail_closed: boolean;
  rolls: Record<string, UnstoredRoll>;
}

export interface SenateUnstoredRecord {
  v: number;
  sessions: Record<string, SenateUnstoredSession>;
}

export function emptySenateUnstored(): SenateUnstoredRecord {
  return { v: SENATE_UNSTORED_VERSION, sessions: {} };
}

/** The session of a Senate roll_call_id (`senate-119-2-00256` → "2"). */
function sessionOf(rollCallId: string): string | null {
  return /^senate-\d+-(\d+)-\d+$/.exec(rollCallId)?.[1] ?? null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shape-validate a raw `pipeline_state.value`. Null when it is not a record of
 * this version; a malformed entry inside a valid record is dropped.
 */
export function parseSenateUnstored(raw: unknown): SenateUnstoredRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { v?: unknown; sessions?: unknown };
  if (r.v !== SENATE_UNSTORED_VERSION) return null;
  if (!r.sessions || typeof r.sessions !== "object" || Array.isArray(r.sessions)) return null;
  const out = emptySenateUnstored();
  for (const [session, rawSession] of Object.entries(r.sessions as Record<string, unknown>)) {
    if (!rawSession || typeof rawSession !== "object") continue;
    const s = rawSession as { tail_closed?: unknown; rolls?: unknown };
    const rolls: Record<string, UnstoredRoll> = {};
    if (s.rolls && typeof s.rolls === "object" && !Array.isArray(s.rolls)) {
      for (const [roll, e] of Object.entries(s.rolls as Record<string, unknown>)) {
        const entry = e as { reason?: unknown; seen_at?: unknown } | null;
        if (sessionOf(roll) !== session) continue;
        if (!entry || typeof entry.reason !== "string" || !REASONS.has(entry.reason)) continue;
        if (typeof entry.seen_at !== "string" || !DATE.test(entry.seen_at)) continue;
        rolls[roll] = { reason: entry.reason as UnstoredReason, seen_at: entry.seen_at };
      }
    }
    out.sessions[session] = { tail_closed: s.tail_closed === true, rolls };
  }
  return out;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * What this run skips and what it fetches again. `seen`: the parser's own
 * reasons, and every other reason inside its RETRY_ABSENT_DAYS window.
 * `recheck`: the rest — fetched with the gaps, and holding the frontier up.
 */
export function senateSkipSets(
  rec: SenateUnstoredRecord,
  today: string,
): { seen: Set<string>; recheck: Set<string> } {
  const seen = new Set<string>();
  const recheck = new Set<string>();
  for (const s of Object.values(rec.sessions)) {
    for (const [roll, e] of Object.entries(s.rolls)) {
      if (PARSER_REASONS.has(e.reason) || daysBetween(e.seen_at, today) < RETRY_ABSENT_DAYS) seen.add(roll);
      else recheck.add(roll);
    }
  }
  return { seen, recheck };
}

/**
 * D3: a session's tail is closed when its year is past and this run's tail
 * walk ended past the end with nothing blocked or transient in it — any such
 * roll could be the session's last, and a closed tail is never walked again.
 */
export function closesTail(year: number, tail: RollProbeSummary["tail"], nowYear: number): boolean {
  return year < nowYear && tail !== null && tail.end === "past-end" && tail.unsure === 0;
}

export interface SenateRunObservation {
  /** This run's `writeRollVotes` skips. */
  unstored: ReadonlyArray<{ roll: string; reason: UnstoredReason }>;
  /** roll_call_ids in `votes` now: this run's landings and the pre-loaded set. Pruned from the record. */
  stored: ReadonlySet<string>;
  /** Sessions whose tail this run closed. */
  tailClosed: ReadonlyArray<number>;
}

/**
 * Fold a run into the record. A roll this run skipped takes this run's reason
 * and today's date; a roll it did not fetch keeps its entry; a roll now in
 * `votes` leaves. `tail_closed` only ever turns on.
 */
export function mergeSenateUnstored(
  prev: SenateUnstoredRecord,
  run: SenateRunObservation,
  today: string,
): { record: SenateUnstoredRecord; added: number; pruned: number } {
  const record = emptySenateUnstored();
  let pruned = 0;
  const sessionFor = (key: string) =>
    (record.sessions[key] ??= { tail_closed: prev.sessions[key]?.tail_closed === true, rolls: {} });

  for (const [key, s] of Object.entries(prev.sessions)) {
    const into = sessionFor(key);
    for (const [roll, e] of Object.entries(s.rolls)) {
      if (run.stored.has(roll)) pruned++;
      else into.rolls[roll] = { ...e };
    }
  }
  let added = 0;
  for (const { roll, reason } of run.unstored) {
    const key = sessionOf(roll);
    if (key === null || run.stored.has(roll)) continue;
    const into = sessionFor(key);
    if (!(roll in into.rolls)) added++;
    into.rolls[roll] = { reason, seen_at: today };
  }
  for (const session of run.tailClosed) sessionFor(String(session)).tail_closed = true;
  return { record, added, pruned };
}

/** `Senate unstored record: N known (M no reference, K no voted_at, J guard-absent), +A added, −R retried` */
export function senateUnstoredLine(
  rec: SenateUnstoredRecord,
  added: number,
  retried: number,
  pruned = 0,
): string {
  const by: Partial<Record<UnstoredReason, number>> = {};
  let known = 0;
  for (const s of Object.values(rec.sessions)) {
    for (const e of Object.values(s.rolls)) {
      known++;
      by[e.reason] = (by[e.reason] ?? 0) + 1;
    }
  }
  const guardAbsent = (by.bill_details_key_collision ?? 0) + (by.bill_details_landing_failed ?? 0);
  const parts = [
    `${by.no_proposal_reference ?? 0} no reference`,
    `${by.no_voted_at ?? 0} no voted_at`,
    `${guardAbsent} guard-absent`,
  ];
  if (by.bill_unresolved) parts.push(`${by.bill_unresolved} bill unresolved`);
  if (by.no_matchable_records) parts.push(`${by.no_matchable_records} no matchable votes`);
  const closed = Object.entries(rec.sessions)
    .filter(([, s]) => s.tail_closed)
    .map(([k]) => k)
    .sort();
  return (
    `  Senate unstored record: ${known} known (${parts.join(", ")}), +${added} added, −${retried} retried` +
    (pruned > 0 ? `, ${pruned} now stored` : "") +
    (closed.length > 0 ? `; tail closed: session ${closed.join(", ")}` : "")
  );
}

// ---------------------------------------------------------------------------
// The row. Both wrappers are best-effort and never throw: a failed read is a
// run with no record (more GETs, as before FIX-1407); a failed write is the
// next run doing this run's GETs again.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function readSenateUnstored(
  db: Db,
  congress: number,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<SenateUnstoredRecord> {
  const key = senateUnstoredKey(congress);
  try {
    const { data, error } = await db.from("pipeline_state").select("value").eq("key", key).maybeSingle();
    if (error) throw new Error(error.message);
    const raw = data?.value ?? null;
    if (raw === null) return emptySenateUnstored();
    const rec = parseSenateUnstored(raw);
    if (rec === null) {
      const v = (raw as { v?: unknown }).v;
      log(`  Senate unstored record: ${key} is v${String(v)}, not v${SENATE_UNSTORED_VERSION} — starting over (every roll fetched once)`);
      return emptySenateUnstored();
    }
    return rec;
  } catch (err) {
    log(
      `  ⚠ FIX-1407: Senate unstored record READ FAILED (${key}: ${err instanceof Error ? err.message : String(err)}) — ` +
        `walking with an empty record: every unstored roll is fetched again tonight`,
    );
    return emptySenateUnstored();
  }
}

export async function writeSenateUnstored(
  db: Db,
  congress: number,
  rec: SenateUnstoredRecord,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<boolean> {
  const key = senateUnstoredKey(congress);
  try {
    const { error } = await db
      .from("pipeline_state")
      .upsert({ key, value: rec, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    log(
      `  ⚠ FIX-1407: Senate unstored record write failed (${key}: ${err instanceof Error ? err.message : String(err)}) — ` +
        `continuing; the next run fetches these rolls again`,
    );
    return false;
  }
}
