/**
 * FIX-1416 — the nomination-rolls manifest and its re-point (cc-309).
 *
 * Runs via:  tsx --test src/scripts/fix1416-nomination-rolls.test.ts
 *
 * No database: D2's qualifying rule, D3's roll rule, D5's refusals, the
 * manifest's columns and TSV; cc-310's retire: the holder kinds, a `block` hit
 * refusing by name, the candidates (dashed only), --census LOCAL only; cc-311
 * D8: the stub's enrichment tasks are cleared, a pending or processing one
 * refuses it.
 * Clone (CIVITICS_CLONE_TESTS=1), cc-310 D8 / cc-311 D9 inside one BEGIN …
 * ROLLBACK: a settling merge, the manifest built on the clone, the re-point (a
 * second pass is a no-op), the merge, --retire-stubs over the real stubs with
 * each read's plan (every dashed stub retired, its queue rows with it), then
 * one task set pending (that stub refused), and the clone's counts back where
 * they started after the ROLLBACK.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  MANIFEST_COLUMNS,
  TYPED_HOLDERS,
  checkTarget,
  clearSql,
  holderLabel,
  holderLines,
  holderSql,
  manifestSummary,
  parseTsv,
  planManifest,
  readTarget,
  repoint,
  retireCandidates,
  retireDecision,
  retireStubs,
  rollDecision,
  standing,
  stubNumber,
  stubRefusal,
  targetOf,
  toTsv,
  type Holder,
  type ManifestRow,
  type RollRow,
  type StubRow,
} from "./fix1416-nomination-rolls";

const PN = { id: "pn-1", bill_number: "PN 22-17", title: "Earl Matthews, of Maryland, to be General Counsel of the Department of Defense", congress: 119 };
const STUB: StubRow = { stub_id: "stub-1", stub_type: "bill", stub_bill_number: "S 22-17", stub_title: "S 22-17", pns: [PN] };

const roll = (over: Partial<RollRow>): RollRow => ({
  proposal_id: "stub-1",
  roll_call_id: "senate-119-1-00441",
  chamber: "Senate",
  vote_question: "On the Nomination",
  voted_at: "2025-07-31T00:00:00.000Z",
  vote_rows: 98,
  ...over,
});

const NOM = roll({});
const CLOTURE = roll({ roll_call_id: "senate-119-1-00440", vote_question: "On the Cloture Motion" });

test("stub numbers: S <n> and S <n>-<m> only", () => {
  assert.equal(stubNumber("S 22-17"), "22-17");
  assert.equal(stubNumber("S 858"), "858");
  assert.equal(stubNumber("S RES 12"), null);
  assert.equal(stubNumber("S 22-17-1"), null);
  assert.equal(stubNumber("PN 22-17"), null);
});

test("D2 + D4: a stub qualifies only with a Senate nomination roll and exactly one PN that shares none of its rolls", () => {
  assert.equal(stubRefusal(STUB, [NOM, CLOTURE]), null);
  assert.match(stubRefusal({ ...STUB, stub_type: "appointment" }, [NOM]) ?? "", /typed appointment/);
  assert.match(stubRefusal({ ...STUB, stub_bill_number: "S RES 12" }, [NOM]) ?? "", /is not S <n>/);
  assert.match(stubRefusal(STUB, [CLOTURE]) ?? "", /no Senate On the Nomination roll/);
  assert.match(stubRefusal(STUB, [roll({ chamber: "House" })]) ?? "", /no Senate On the Nomination roll/);
  assert.match(stubRefusal({ ...STUB, pns: [] }, [NOM]) ?? "", /no appointment proposal numbered PN 22-17/);
  assert.match(stubRefusal({ ...STUB, pns: [PN, { ...PN, id: "pn-2" }] }, [NOM]) ?? "", /2 appointment proposals/);
  // D4: a PN with rolls of its own is fine; a PN holding one of the stub's roll ids is not.
  assert.equal(stubRefusal(STUB, [NOM, roll({ proposal_id: "pn-1", roll_call_id: "senate-119-1-00500" })]), null);
  assert.match(stubRefusal(STUB, [NOM, roll({ proposal_id: "pn-1", vote_rows: 2 })]) ?? "", /already carries senate-119-1-00441/);
});

test("D3: every Senate roll on a dashed stub moves; a short stub's roll only on its LIS document or, unread, its question", () => {
  assert.deepEqual(rollDecision(STUB, PN, NOM, 98), { basis: "dashed", action: "move" });
  assert.deepEqual(rollDecision(STUB, PN, CLOTURE, 98), { basis: "dashed", action: "move" });
  assert.match(rollDecision(STUB, PN, roll({ chamber: "House", roll_call_id: "house-119-1-00012" }), 98).action, /not a Senate roll/);
  assert.match(rollDecision(STUB, PN, NOM, 100).action, /2 of the roll's rows are on another proposal/);
  assert.match(rollDecision(STUB, { ...PN, congress: 118 }, NOM, 98).action, /congress 119 is not the PN's 118/);

  const short: StubRow = { ...STUB, stub_bill_number: "S 858", stub_title: "Hershel 'Woody' Williams National Medal of Honor Monument Location Act" };
  const pn858 = { ...PN, bill_number: "PN 858" };
  const lis = {
    "senate-119-2-00062": { type: "PN", number: "858" },
    "senate-119-2-00063": { type: "PN", number: "858" },
    "senate-119-2-00070": { type: "S.", number: "858" },
    "senate-119-2-00071": { type: "PN", number: "859" },
  };
  const at = (id: string, q = "On the Cloture Motion") => rollDecision(short, pn858, roll({ roll_call_id: id, vote_question: q }), 98, lis);
  assert.deepEqual(at("senate-119-2-00062"), { basis: "lis PN 858", action: "move" });
  assert.deepEqual(at("senate-119-2-00063", "On the Nomination"), { basis: "lis PN 858", action: "move" });
  assert.match(at("senate-119-2-00070", "On Passage of the Bill").action, /LIS document is not this PN/);
  assert.match(at("senate-119-2-00071").action, /LIS document is not this PN/);
  // Unread (a 403): the nomination roll moves on its question; nothing else does.
  assert.deepEqual(at("senate-119-2-00090", "On the Nomination"), { basis: "question", action: "move" });
  assert.match(at("senate-119-2-00089").action, /LIS document not read/);
});

test("the manifest: one line per (roll, stub) in the stated columns; a refused stub's rolls are skip lines", () => {
  const other: StubRow = { stub_id: "stub-2", stub_type: "bill", stub_bill_number: "S 5-1", stub_title: "S 5-1", pns: [] };
  const rows = planManifest(
    [other, STUB],
    [NOM, CLOTURE, roll({ proposal_id: "stub-2", roll_call_id: "senate-119-1-00010" })],
    new Map([["senate-119-1-00441", 98], ["senate-119-1-00440", 98], ["senate-119-1-00010", 98]]),
  );
  assert.deepEqual(Object.keys(rows[0]!), [...MANIFEST_COLUMNS]);
  assert.deepEqual(
    rows.map((r) => [r.stub_bill_number, r.roll_call_id, r.pn_bill_number, r.action]),
    [
      ["S 5-1", "senate-119-1-00010", "", "skip: no appointment proposal numbered PN 5-1"],
      ["S 22-17", "senate-119-1-00440", "PN 22-17", "move"],
      ["S 22-17", "senate-119-1-00441", "PN 22-17", "move"],
    ],
  );
  assert.deepEqual(manifestSummary(rows), {
    stubs: 1,
    rolls: 2,
    vote_rows: 196,
    by_question: { "On the Cloture Motion": { rolls: 1, vote_rows: 98 }, "On the Nomination": { rolls: 1, vote_rows: 98 } },
    skipped: { "skip: no appointment proposal numbered PN 5-1": 1 },
  });
  assert.deepEqual(parseTsv(toTsv(rows)), rows);
  assert.deepEqual(parseTsv(toTsv(rows).replace(/\n/g, "\r\n")), rows);
  assert.throws(() => parseTsv("a\tb\n1\t2\n"), /manifest header/);
});

test("D5: a roll moves only from where the manifest left it; a roll already on its PN is counted; anything else aborts", () => {
  const m = planManifest([STUB], [NOM], new Map([["senate-119-1-00441", 98]]))[0]!;
  const t = { on_stub: 98, on_pn: 0, on_roll: 98, stub_bill_number: "S 22-17", pn_type: "appointment", pn_bill_number: "PN 22-17" };
  assert.equal(checkTarget(m, t), "move");
  assert.equal(checkTarget(m, { ...t, on_stub: 0, on_pn: 98, stub_bill_number: null }), "already");
  assert.throws(() => checkTarget(m, { ...t, on_stub: 97, on_roll: 97 }), /manifest 98 rows on the stub; target 97/);
  assert.throws(() => checkTarget(m, { ...t, on_roll: 99 }), /99 on the roll/);
  assert.throws(() => checkTarget(m, { ...t, on_stub: 50, on_pn: 48 }), /target 50 on the stub, 48 on the PN/);
  assert.throws(() => checkTarget(m, { ...t, pn_type: "bill" }), /is bill PN 22-17, not appointment/);
  assert.throws(() => checkTarget(m, { ...t, pn_type: null, pn_bill_number: null }), /is missing/);
  assert.throws(() => checkTarget(m, { ...t, pn_bill_number: "PN 22-18" }), /not appointment PN 22-17/);
  assert.throws(() => checkTarget(m, { ...t, stub_bill_number: "S 22-18" }), /numbered S 22-18 here/);
});

const QUEUE_CLEAR = "enrichment_queue.entity_id";
const QUEUE_BLOCK = "enrichment_queue.entity_id (status pending / processing)";

test("cc-310 D5 + cc-311 D8: the holder kinds — four cleared, two left to their owners, page_views kept, every typed read by (type, id)", () => {
  const of = (k: Holder["kind"]) => TYPED_HOLDERS.filter((h) => h.kind === k).map(holderLabel).sort();
  assert.deepEqual(of("clear"), [QUEUE_CLEAR, "entity_search_index.entity_id", "entity_tags.entity_id", "external_source_refs.entity_id"]);
  assert.deepEqual(of("leave"), ["entity_connection_stats_mv.entity_id", "proposal_trending_24h.proposal_id"]);
  assert.deepEqual(of("keep"), ["page_views.entity_id"]);
  for (const l of ["entity_connections.from_id", "entity_connections.to_id", QUEUE_BLOCK, "ai_summary_cache.entity_id"]) {
    assert.ok(of("block").includes(l), l);
  }
  assert.ok(!of("block").includes(QUEUE_CLEAR), "a done / failed / skipped task no longer refuses");
  assert.equal(new Set(TYPED_HOLDERS.map(holderLabel)).size, TYPED_HOLDERS.length, "one line per holder");
  for (const h of TYPED_HOLDERS) {
    if (h.kind === "leave") {
      assert.equal(h.type, null, `${holderLabel(h)} is keyed by the proposal alone`);
      continue;
    }
    assert.ok(h.type, `${holderLabel(h)} carries its type value`);
    assert.ok(holderSql(h).includes(`"${h.type.col}" = '${h.type.value}' AND "${h.idCol}" = ANY($1::`), holderSql(h));
  }
  const queue = (label: string) => TYPED_HOLDERS.find((h) => holderLabel(h) === label)!;
  assert.match(holderSql(queue(QUEUE_CLEAR)), /ANY\(\$1::text\[\]\)/, "a text id compares as text");
  assert.match(holderSql(TYPED_HOLDERS.find((h) => h.rel === "entity_tags")!), /ANY\(\$1::uuid\[\]\)/);
  assert.equal(clearSql(TYPED_HOLDERS.find((h) => h.rel === "entity_tags")!),
    `DELETE FROM public."entity_tags" WHERE "entity_type" = 'proposal' AND "entity_id" = ANY($1::uuid[])`);
  // cc-311 D8: the clear takes every task of the stub; the block reads only the claimable and the claimed.
  assert.equal(clearSql(queue(QUEUE_CLEAR)),
    `DELETE FROM public."enrichment_queue" WHERE "entity_type" = 'proposal' AND "entity_id" = ANY($1::text[])`);
  assert.equal(holderSql(queue(QUEUE_BLOCK)),
    `SELECT "entity_id"::text AS id, count(*)::int AS n FROM public."enrichment_queue" WHERE "entity_type" = 'proposal' AND "entity_id" = ANY($1::text[]) AND "status" IN ('pending', 'processing') GROUP BY 1`);
  assert.throws(() => clearSql(queue(QUEUE_BLOCK)), /is block, not clear/);
  assert.throws(() => clearSql(TYPED_HOLDERS.find((h) => h.kind === "keep")!), /is keep, not clear/);
});

test("cc-311 D8: a pending task refuses the stub by name, a processing one refuses; done / failed / skipped_no_source_text do not", () => {
  const queueHolders = TYPED_HOLDERS.filter((h) => h.rel === "enrichment_queue");
  assert.equal(queueHolders.length, 2);
  // What each holder's read counts of one stub's task rows — its (type, id) and its `only`, as holderSql renders them.
  const countsFor = (rows: Array<{ entity_id: string; entity_type: string; status: string }>) =>
    queueHolders.map((holder) => {
      const byId = new Map<string, number>();
      for (const r of rows) {
        if (r.entity_type !== holder.type!.value) continue;
        if (holder.only && !holder.only.values.includes(r.status)) continue;
        byId.set(r.entity_id, (byId.get(r.entity_id) ?? 0) + 1);
      }
      return { holder, byId };
    });
  const stub = { stub_id: "s1", stub_bill_number: "S 22-17" };
  const state = new Map([["s1", { type: "bill", title: "S 22-17", bill_number: "S 22-17" }]]);
  const decide = (status: string) => retireDecision([stub], state, countsFor([{ entity_id: "s1", entity_type: "proposal", status }]));
  assert.deepEqual(decide("pending").refused, [{ ...stub, why: [`${QUEUE_BLOCK} 1`] }]);
  assert.deepEqual(decide("processing").refused, [{ ...stub, why: [`${QUEUE_BLOCK} 1`] }]);
  for (const s of ["done", "failed", "skipped_no_source_text"]) {
    const r = decide(s);
    assert.deepEqual([r.retire, r.refused], [["s1"], []], s);
  }
  // Another entity type's task under the same id is not the stub's.
  assert.deepEqual(retireDecision([stub], state, countsFor([{ entity_id: "s1", entity_type: "official", status: "pending" }])).retire, ["s1"]);
  // The clear line and the block line print apart.
  const lines = holderLines(countsFor([{ entity_id: "s1", entity_type: "proposal", status: "done" }]), ["s1"]);
  assert.deepEqual(lines, [
    `block ${QUEUE_BLOCK} [entity_type = 'proposal', text id, status IN ('pending', 'processing')]: stubs 0, rows 0, of the retired 0 — ${queueHolders.find((h) => h.kind === "block")!.why}`,
    `clear ${QUEUE_CLEAR} [entity_type = 'proposal', text id]: stubs 1, rows 1, of the retired 1 — ${queueHolders.find((h) => h.kind === "clear")!.why}`,
  ]);
});

test("cc-310 D5: a block hit refuses the stub and names the relation; clear, leave and keep rows never refuse", () => {
  const block = TYPED_HOLDERS.find((h) => h.rel === "enrichment_queue" && h.kind === "block")!;
  const fk: Holder = { kind: "block", rel: "votes", idCol: "bill_proposal_id", type: null, why: "FK → bill_details(proposal_id) ON DELETE CASCADE" };
  const others = TYPED_HOLDERS.filter((h) => h.kind !== "block");
  const cands = [{ stub_id: "a", stub_bill_number: "S 22-17" }, { stub_id: "b", stub_bill_number: "S 5-1" }, { stub_id: "c", stub_bill_number: "S 6-2" }];
  const state = new Map([
    ["a", { type: "bill", title: "S 22-17", bill_number: "S 22-17" }],
    ["b", { type: "bill", title: "S 5-1", bill_number: "S 5-1" }],
    ["c", { type: "bill", title: "Some Act", bill_number: "S 6-2" }],
  ]);
  const counts = [
    { holder: block, byId: new Map([["b", 1]]) },
    { holder: fk, byId: new Map([["b", 98]]) },
    ...others.map((holder) => ({ holder, byId: new Map([["a", 3], ["b", 1]]) })),
  ];
  const r = retireDecision(cands, state, counts);
  assert.deepEqual(r.retire, ["a"]);
  assert.deepEqual(r.refused, [
    { stub_id: "b", stub_bill_number: "S 5-1", why: [`${QUEUE_BLOCK} 1`, "votes.bill_proposal_id 98"] },
    { stub_id: "c", stub_bill_number: "S 6-2", why: ["title is not its number"] },
  ]);
  assert.deepEqual(retireDecision(cands.slice(0, 1), new Map(), []).refused[0]!.why, ["no proposals row"]);
});

test("cc-310 D5: a short stub and S 858 are never retire candidates; a dashed move stub is, once", () => {
  const line = (stub_id: string, stub_bill_number: string, action = "move"): ManifestRow =>
    ({ ...planManifest([STUB], [NOM], new Map([["senate-119-1-00441", 98]]))[0]!, stub_id, stub_bill_number, action });
  const m = [
    line("s858", "S 858"), line("s19", "S 19"), line("d1", "S 22-17"), line("d1", "S 22-17"),
    line("d2", "S 5-1", "skip: no appointment proposal numbered PN 5-1"),
  ];
  assert.deepEqual(retireCandidates(m), [{ stub_id: "d1", stub_bill_number: "S 22-17" }]);
});

test("cc-310 D6: --census refuses a non-local database, with or without --allow-prod", () => {
  const prod = "postgresql://postgres.xsazcoxinpgttgquwvuf:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  const local = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  assert.throws(() => targetOf(prod, ["--census"]), /LOCAL only/);
  assert.throws(() => targetOf(prod, ["--census", "--allow-prod"]), /LOCAL only/);
  assert.equal(targetOf(local, ["--census"]), "LOCAL");
  assert.throws(() => targetOf(prod, ["--retire-stubs"]), /without --allow-prod/);
  assert.equal(targetOf(prod, ["--retire-stubs", "--allow-prod"]), "PROD");
});

// ---------------------------------------------------------------------------
// The clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function merge(c: Client): Promise<{ line: string; ms: number; counts: Record<string, number> }> {
  const notices: string[] = [];
  const on = (n: { message?: string }) => notices.push(n.message ?? "");
  c.on("notice", on);
  const t0 = Date.now();
  try {
    await c.query("SELECT * FROM public.rebuild_entity_connections_votes_full()");
  } finally {
    c.off("notice", on);
  }
  const ms = Date.now() - t0;
  const line = notices.find((m) => m.startsWith("[votes_full] merge:"));
  assert.ok(line, `no merge NOTICE in ${JSON.stringify(notices)}`);
  const m = line.match(/deleted (\d+) \/ retyped (\d+) \/ updated (\d+) \/ inserted (\d+) \/ untouched (\d+)$/);
  assert.ok(m, line);
  const [deleted, retyped, updated, inserted, untouched] = m.slice(1).map(Number) as [number, number, number, number, number];
  return { line, ms, counts: { deleted, retyped, updated, inserted, untouched } };
}

test("clone (D8): re-point, merge and retire in one transaction, measured, then ROLLBACK leaves the clone as it was", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  const log = (s: string) => console.info(`[fix1416 D8] ${s}`);
  try {
    const target0 = await readTarget(c);
    const manifest0 = planManifest(target0.stubs, target0.rolls, target0.rollTotals);
    const before = await standing(c, manifest0);
    log(`before: ${JSON.stringify(before)} · manifest ${JSON.stringify(manifestSummary(manifest0))}`);

    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '30min'");
      // Settle whatever drift the clone holds first, so the second NOTICE is the re-point's alone.
      const settle = await merge(c);
      log(`settling merge: ${settle.line} in ${settle.ms} ms`);

      const target = await readTarget(c);
      const manifest = planManifest(target.stubs, target.rolls, target.rollTotals);
      const summary = manifestSummary(manifest);
      assert.equal(summary.stubs, new Set(manifest.map((r) => r.stub_id)).size, `skips: ${JSON.stringify(summary.skipped)}`);
      const edges0 = await standing(c, manifest);

      const t0 = Date.now();
      const r = await repoint(c, manifest);
      const repointMs = Date.now() - t0;
      log(`re-point: ${r.moved_rows} rows on ${r.moved_rolls} rolls in ${repointMs} ms (manifest ${summary.vote_rows} / ${summary.rolls})`);
      assert.equal(r.moved_rows, summary.vote_rows);
      assert.equal(r.moved_rolls, summary.rolls);
      assert.equal(r.already, 0);
      const again = await repoint(c, manifest);
      assert.deepEqual(again, { moved_rows: 0, moved_rolls: 0, already: summary.rolls }, "a second pass is a no-op");

      const mid = await standing(c, manifest);
      assert.equal(mid["rows_on_stubs"], before["rows_on_stubs"]! - summary.vote_rows);
      assert.equal(mid["rows_on_pns"], before["rows_on_pns"]! + summary.vote_rows);

      const m = await merge(c);
      log(`merge: ${m.line} in ${m.ms} ms`);
      const after = await standing(c, manifest);
      log(`after the merge: ${JSON.stringify(after)}`);
      assert.equal(after["edges_on_stubs"], 0, "no vote edge is left on a stub");
      // Each stub maps to one PN that held no roll, so every (official, stub) pair becomes one (official, PN) pair.
      assert.equal(m.counts["deleted"], edges0["edges_on_stubs"]);
      assert.equal(m.counts["inserted"], edges0["edges_on_stubs"]);
      assert.equal(after["edges_on_pns"], edges0["edges_on_pns"]! + edges0["edges_on_stubs"]!);
      assert.equal(m.counts["retyped"]! + m.counts["updated"]!, 0, "the merge touched nothing else");

      // --retire-stubs (cc-310 D5 / D7) over the real stubs.
      const cands = retireCandidates(manifest);
      const dashedIds = cands.map((x) => x.stub_id);
      const shortIds = [...new Set(manifest.filter((x) => x.action === "move" && !/^S \d+-\d+$/.test(x.stub_bill_number)).map((x) => x.stub_id))];
      const held = async (ids: readonly string[]) => {
        const out: Record<string, number> = {};
        for (const h of TYPED_HOLDERS.filter((x) => x.kind !== "block")) {
          out[holderLabel(h)] = (await c.query<{ n: number }>(`SELECT coalesce(sum(n), 0)::int AS n FROM (${holderSql(h)}) z`, [ids])).rows[0]!.n;
        }
        out["bill_details.proposal_id"] = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.bill_details WHERE proposal_id = ANY($1::uuid[])", [ids])).rows[0]!.n;
        out["proposals.id"] = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.proposals WHERE id = ANY($1::uuid[])", [ids])).rows[0]!.n;
        return out;
      };
      const dashed0 = await held(dashedIds);
      const short0 = await held(shortIds);
      log(`the ${dashedIds.length} dashed stubs hold: ${JSON.stringify(dashed0)} · the ${shortIds.length} short: ${JSON.stringify(short0)}`);

      // 1. As the script runs it (cc-311 D8: the stubs' enrichment tasks are a clear; none of them is
      //    pending or processing on the clone). Inside a savepoint, so the stubs are back for step 2.
      await c.query("SAVEPOINT retire_as_built");
      const t1 = Date.now();
      const ret = await retireStubs(c, manifest);
      log(`retire as built: ${ret.retired.length} retired, ${ret.refused.length} refused in ${Date.now() - t1} ms; deleted ${JSON.stringify(ret.cleared)}`);
      for (const line of holderLines(ret.counts, ret.retired)) log(`  ${line}`);
      for (const p of ret.plans) log(`  plan ${p.label}: ${p.nodes.join(" → ")}`);
      assert.ok(ret.plans.every((p) => p.heavy.length === 0), "no retire-time read sequential-scans a relation over 1,000 pages");
      for (const x of ret.refused) log(`  refused ${x.stub_bill_number} ${x.stub_id}: ${x.why.join("; ")}`);
      assert.deepEqual(ret.refused, []);
      assert.equal(ret.retired.length, cands.length);
      assert.equal(ret.cleared["bill_details.proposal_id"], cands.length);
      assert.equal(ret.cleared["proposals.id"], cands.length);
      for (const h of TYPED_HOLDERS.filter((x) => x.kind === "clear")) {
        assert.equal(ret.cleared[holderLabel(h)], dashed0[holderLabel(h)], `${holderLabel(h)}: the dashed stubs' rows, all of them`);
      }
      assert.equal(ret.cleared["enrichment_queue.entity_id"], cands.length, "one tag task per dashed stub");
      const dashed1 = await held(dashedIds);
      for (const h of TYPED_HOLDERS.filter((x) => x.kind === "leave" || x.kind === "keep")) {
        assert.equal(dashed1[holderLabel(h)], dashed0[holderLabel(h)], `${holderLabel(h)} is not written`);
      }
      for (const h of TYPED_HOLDERS.filter((x) => x.kind === "clear")) assert.equal(dashed1[holderLabel(h)], 0, `${holderLabel(h)}: nothing left behind`);
      assert.deepEqual(await held(shortIds), short0, "the seven short stubs and their rows (their queue rows too) are untouched");
      assert.equal(short0["enrichment_queue.entity_id"], shortIds.length, "one task per short stub");
      await c.query("ROLLBACK TO SAVEPOINT retire_as_built");

      // 2. One dashed stub's task made claimable: that stub alone is refused, by the queue's block line.
      await c.query("SAVEPOINT retire_pending");
      const one = dashedIds[0]!;
      const pend = await c.query("UPDATE public.enrichment_queue SET status = 'pending' WHERE entity_type = 'proposal' AND entity_id = $1", [one]);
      assert.equal(pend.rowCount, 1);
      const r2 = await retireStubs(c, manifest);
      log(`retire with one task pending: ${r2.retired.length} retired, ${r2.refused.length} refused; ${r2.refused.map((x) => `${x.stub_bill_number}: ${x.why.join("; ")}`).join(" | ")}`);
      for (const line of holderLines(r2.counts, r2.retired).filter((l) => l.includes("enrichment_queue"))) log(`  ${line}`);
      assert.equal(r2.retired.length, cands.length - 1);
      assert.deepEqual(r2.refused.map((x) => [x.stub_id, x.why]), [[one, ["enrichment_queue.entity_id (status pending / processing) 1"]]]);
      assert.equal(r2.cleared["enrichment_queue.entity_id"], cands.length - 1);
      await c.query("ROLLBACK TO SAVEPOINT retire_pending");
    } finally {
      await c.query("ROLLBACK");
    }

    const back = await standing(c, manifest0);
    log(`after ROLLBACK: ${JSON.stringify(back)}`);
    assert.deepEqual(back, before);
  } finally {
    await c.end();
  }
});
