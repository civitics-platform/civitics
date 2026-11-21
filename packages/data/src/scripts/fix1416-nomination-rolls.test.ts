/**
 * FIX-1416 — the nomination-rolls manifest and its re-point (cc-309).
 *
 * Runs via:  tsx --test src/scripts/fix1416-nomination-rolls.test.ts
 *
 * No database: D2's qualifying rule, D3's roll rule, D5's refusals, the
 * manifest's columns and TSV.
 * Clone (CIVITICS_CLONE_TESTS=1), D8 inside one BEGIN … ROLLBACK: a settling
 * merge, the manifest built on the clone, the re-point (a second pass is a
 * no-op), the merge, --retire-stubs' deletes (the real stubs refused for what
 * still points at them; a synthetic unreferenced dashed stub retired), and the
 * clone's counts back where they started after the ROLLBACK.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  MANIFEST_COLUMNS,
  checkTarget,
  manifestSummary,
  parseTsv,
  planManifest,
  readTarget,
  repoint,
  retireStubs,
  rollDecision,
  standing,
  stubNumber,
  stubRefusal,
  toTsv,
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

      // --retire-stubs: a synthetic dashed stub nothing points at goes; each real one is refused by name.
      const seed = manifest.find((x) => x.action === "move")!;
      const fake = (await c.query<{ id: string }>(
        `INSERT INTO public.proposals (type, status, jurisdiction_id, title)
         SELECT type, status, jurisdiction_id, 'S 99999-99' FROM public.proposals WHERE id = $1 RETURNING id`,
        [seed.stub_id],
      )).rows[0]!.id;
      await c.query(
        `INSERT INTO public.bill_details (proposal_id, bill_number, jurisdiction_id)
         SELECT $1, 'S 99999-99', jurisdiction_id FROM public.bill_details WHERE proposal_id = $2`,
        [fake, seed.stub_id],
      );
      const withFake: ManifestRow[] = [...manifest, { ...seed, stub_id: fake, stub_bill_number: "S 99999-99", roll_call_id: "senate-119-9-99999" }];
      const t1 = Date.now();
      const ret = await retireStubs(c, withFake);
      log(`retire: ${ret.retired.length} retired, ${ret.refused.length} refused in ${Date.now() - t1} ms`);
      const why = new Map<string, number>();
      for (const x of ret.refused) for (const w of x.why) why.set(w.replace(/ \d+$/, ""), (why.get(w.replace(/ \d+$/, "")) ?? 0) + 1);
      log(`refused because: ${JSON.stringify(Object.fromEntries([...why].sort()))}`);
      assert.ok(ret.retired.includes(fake), "the unreferenced synthetic stub is retired");
      const dashed = new Set(manifest.filter((x) => x.action === "move" && /^S \d+-\d+$/.test(x.stub_bill_number)).map((x) => x.stub_id));
      assert.equal(ret.retired.length + ret.refused.length, dashed.size + 1, "every dashed stub is retired or refused; no short one is considered");
      assert.ok(ret.refused.every((x) => !x.why.some((w) => w.startsWith("votes.") || w.startsWith("entity_connections."))), "no vote row or edge is left on a stub");
      const gone = await c.query(
        "SELECT (SELECT count(*)::int FROM public.proposals WHERE id = ANY($1::uuid[])) AS p, (SELECT count(*)::int FROM public.bill_details WHERE proposal_id = ANY($1::uuid[])) AS bd",
        [ret.retired],
      );
      assert.deepEqual(gone.rows[0], { p: 0, bd: 0 });
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
