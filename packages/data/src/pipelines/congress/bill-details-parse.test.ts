/**
 * FIX-1452 (cc-327 Item 1) — the bill-details walker's parsers, over the real
 * congress.gov responses read 2 saved (HR 1 and SJRES 18 of the 119th,
 * 2026-11-26; SJRES 18's cosponsors also as two `limit=10` pages).
 *
 * Runs via:  tsx --test src/pipelines/congress/bill-details-parse.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionSourceKey,
  buildBioguideResolver,
  decideIntroduced,
  decideTitle,
  httpStatusOf,
  isTransient,
  needsCosponsors,
  needsTitles,
  nextPage,
  parseActionPages,
  parseBillDetail,
  parseBillKey,
  parseCosponsorPages,
  pickShortTitle,
  resolveCosponsors,
  type ActionsPage,
  type BillDetailResponse,
  type CosponsorsPage,
  type TitlesPage,
} from "./bill-details-parse";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8")) as T;
}

const hr1Detail = fixture<BillDetailResponse>("bill-119-hr-1-detail.json");
const hr1Cosponsors = fixture<CosponsorsPage>("bill-119-hr-1-cosponsors.json");
const hr1Actions = fixture<ActionsPage>("bill-119-hr-1-actions.json");
const hr1Titles = fixture<TitlesPage>("bill-119-hr-1-titles.json");
const sj18Detail = fixture<BillDetailResponse>("bill-119-sjres-18-detail.json");
const sj18Cosponsors = fixture<CosponsorsPage>("bill-119-sjres-18-cosponsors.json");
const sj18P1 = fixture<CosponsorsPage>("bill-119-sjres-18-cosponsors-p1.json");
const sj18P2 = fixture<CosponsorsPage>("bill-119-sjres-18-cosponsors-p2.json");
const sj18Actions = fixture<ActionsPage>("bill-119-sjres-18-actions.json");
const sj18Titles = fixture<TitlesPage>("bill-119-sjres-18-titles.json");

// ── the measure key ─────────────────────────────────────────────────────────

test("parseBillKey: a bill or resolution key parses; a nomination's and an unknown type's do not", () => {
  assert.deepEqual(parseBillKey("119-HR-1"), { congress: 119, type: "hr", number: "1" });
  assert.deepEqual(parseBillKey("118-SJRES-38"), { congress: 118, type: "sjres", number: "38" });
  assert.equal(parseBillKey("119-PN-11-11"), null, "nominations carry a congress_gov ref too (read 5: 736 on prod)");
  assert.equal(parseBillKey("119-PN-12"), null);
  assert.equal(parseBillKey("119-XX-1"), null);
  assert.equal(parseBillKey("HR-1"), null);
});

test("httpStatusOf reads fetchCongressApi's error; 429, 5xx and no response are transient", () => {
  assert.equal(httpStatusOf(new Error("Congress.gov API error: 429 Too Many Requests — https://x\n  Body: ")), 429);
  assert.equal(httpStatusOf(new Error("Congress.gov API error: 404 Not Found — https://x")), 404);
  assert.equal(httpStatusOf(new TypeError("fetch failed")), null);
  assert.equal(isTransient(429), true);
  assert.equal(isTransient(503), true);
  assert.equal(isTransient(null), true);
  assert.equal(isTransient(404), false);
  assert.equal(isTransient(400), false);
});

// ── detail ──────────────────────────────────────────────────────────────────

test("parseBillDetail: HR 1's sponsor, introduced date, title and policy area as the source gives them", () => {
  const d = parseBillDetail(hr1Detail);
  assert.deepEqual(d.sponsor, {
    bioguide: "A000375",
    name: "Rep. Arrington, Jodey C. [R-TX-19]",
    party: "R",
    state: "TX",
    district: 19,
  });
  assert.equal(d.sponsorsListed, 1);
  assert.equal(d.introducedDate, "2025-05-20");
  assert.equal(d.title, "An act to provide for reconciliation pursuant to title II of H. Con. Res. 14.");
  assert.equal(d.policyArea, "Economics and Public Finance");
  assert.equal(d.actionCount, 59);
  assert.equal(d.titleCount, 12);
});

test("parseBillDetail: an absent cosponsors key is a count of 0, and the cosponsors request is skipped", () => {
  const d = parseBillDetail(hr1Detail);
  assert.equal(hr1Detail.bill?.cosponsors, undefined, "HR 1's detail carries no cosponsors key");
  assert.equal(d.cosponsorCount, 0);
  assert.equal(d.cosponsorCountIncludingWithdrawn, 0);
  assert.equal(needsCosponsors(d), false);
  assert.equal(needsTitles(d), true);
  // …and the cosponsors endpoint agrees.
  assert.equal(parseCosponsorPages([hr1Cosponsors]).count, 0);
});

test("parseBillDetail: SJRES 18 lists 16 cosponsors, so the request is made", () => {
  const d = parseBillDetail(sj18Detail);
  assert.equal(d.cosponsorCount, 16);
  assert.equal(needsCosponsors(d), true);
  assert.ok(d.sponsor?.bioguide, "a Senate resolution's sponsor carries a bioguide (read 2: D3 holds)");
  assert.equal(d.sponsor?.district, undefined, "a Senator has no district");
});

test("parseBillDetail: no sponsor, or two, is no sponsor", () => {
  assert.equal(parseBillDetail({ bill: { sponsors: [] } }).sponsor, null);
  const two = parseBillDetail({ bill: { sponsors: [{ bioguideId: "A1" }, { bioguideId: "B2" }] } });
  assert.equal(two.sponsor, null);
  assert.equal(two.sponsorsListed, 2);
  assert.equal(parseBillDetail({ bill: { sponsors: [{ fullName: "no id" }] } }).sponsor, null);
});

// ── cosponsors ──────────────────────────────────────────────────────────────

test("parseCosponsorPages: SJRES 18's 16 cosponsors, with the original flag and the sponsorship date", () => {
  const c = parseCosponsorPages([sj18Cosponsors]);
  assert.equal(c.items.length, 16);
  assert.equal(c.count, 16);
  assert.equal(c.countIncludingWithdrawn, 16);
  assert.equal(c.noBioguide, 0);
  const first = c.items[0]!;
  assert.equal(first.bioguide, "R000605");
  assert.equal(first.isOriginal, true);
  assert.equal(first.dateAdded, "2025-02-13");
  assert.equal(first.dateWithdrawn, null);
});

test("parseCosponsorPages: a paginated list reads the same as the one page", () => {
  assert.equal(nextPage(sj18P1), "https://api.congress.gov/v3/bill/119/sjres/18/cosponsors?offset=10&limit=10&format=json");
  assert.equal(nextPage(sj18P2), null);
  const paged = parseCosponsorPages([sj18P1, sj18P2]);
  const whole = parseCosponsorPages([sj18Cosponsors]);
  assert.equal(sj18P1.cosponsors?.length, 10);
  assert.equal(sj18P2.cosponsors?.length, 6);
  assert.deepEqual(paged.items.map((i) => i.bioguide).sort(), whole.items.map((i) => i.bioguide).sort());
  assert.equal(paged.count, 16);
});

test("parseCosponsorPages: a withdrawn cosponsor keeps its withdrawn date", () => {
  const c = parseCosponsorPages([{
    cosponsors: [{ bioguideId: "W1", isOriginalCosponsor: false, sponsorshipDate: "2025-03-01", sponsorshipWithdrawnDate: "2025-04-02" }],
    pagination: { count: 0, countIncludingWithdrawnCosponsors: 1 },
  }]);
  assert.equal(c.items[0]!.dateWithdrawn, "2025-04-02");
  assert.equal(c.count, 0);
  assert.equal(c.countIncludingWithdrawn, 1);
});

// ── the resolver ────────────────────────────────────────────────────────────

test("buildBioguideResolver: one match resolves, none and two do not (§E13 — never a guess)", () => {
  const resolve = buildBioguideResolver([
    { id: "o-1", source_ids: { congress_gov: "R000605" } },
    { id: "o-2", source_ids: { congress_gov: "H000601" } },
    { id: "o-3", source_ids: { congress_gov: "H000601" } },
    { id: "o-4", source_ids: { fec_candidate_id: "S0XX00000" } },
    { id: "o-5", source_ids: null },
    { id: "o-1", source_ids: { congress_gov: "R000605" } },
  ]);
  assert.deepEqual(resolve("R000605"), { kind: "one", id: "o-1" }, "the same row twice is still one row");
  assert.deepEqual(resolve("H000601"), { kind: "many", ids: ["o-2", "o-3"] });
  assert.deepEqual(resolve("Z999999"), { kind: "none" });
});

test("resolveCosponsors: resolved rows, unresolved kept with bioguide + name, a repeated official once", () => {
  const items = parseCosponsorPages([sj18Cosponsors]).items;
  const [a, b, c] = items.map((i) => i.bioguide);
  const resolve = buildBioguideResolver([
    { id: "o-a", source_ids: { congress_gov: a! } },
    { id: "o-b1", source_ids: { congress_gov: b! } },
    { id: "o-b2", source_ids: { congress_gov: b! } },
    { id: "o-c", source_ids: { congress_gov: c! } },
  ]);
  const out = resolveCosponsors([...items, items[0]!], resolve);
  assert.deepEqual(out.rows.map((r) => r.official_id), ["o-a", "o-c"]);
  assert.equal(out.repeated, 1);
  assert.equal(out.unresolved.length, 14);
  assert.deepEqual(out.unresolved.find((u) => u.bioguide === b), { bioguide: b, name: items[1]!.name, why: "many" });
  assert.equal(out.unresolved.filter((u) => u.why === "none").length, 13);
  assert.equal(out.rows[0]!.is_original_cosponsor, true);
  assert.equal(out.rows[0]!.date_added, "2025-02-13");
});

// ── actions ─────────────────────────────────────────────────────────────────

test("parseActionPages: HR 1's 59 actions, every one kept under its own key", () => {
  const p = parseActionPages([hr1Actions]);
  assert.equal(p.count, 59);
  assert.equal(p.rows.length, 59);
  assert.equal(p.undated, 0);
  assert.equal(p.duplicateKey, 0);
  assert.equal(new Set(p.rows.map((r) => r.source_key)).size, 59);
});

test("the old key (proposal, type, date+time) merges actions the source key keeps apart — both fixtures", () => {
  for (const page of [hr1Actions, sj18Actions]) {
    const acts = page.actions ?? [];
    const oldKeys = new Map<string, number>();
    for (const a of acts) {
      const k = `${a.type}|${a.actionDate}|${a.actionTime ?? ""}`;
      oldKeys.set(k, (oldKeys.get(k) ?? 0) + 1);
    }
    const merged = [...oldKeys.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
    assert.ok(merged > 0, "the old unique key would have collided");
    assert.equal(parseActionPages([page]).rows.length, acts.length, "the source key stores every one");
  }
  // The named pair: HR 1, 2025-07-04, both type BecameLaw, code 36000, no time.
  const pair = (hr1Actions.actions ?? []).filter((a) => a.type === "BecameLaw" && a.actionDate === "2025-07-04");
  assert.equal(pair.length, 2);
  assert.notEqual(actionSourceKey(pair[0]!), actionSourceKey(pair[1]!));
});

test("parseActionPages: a timed action is Eastern wall time; a date-only one is Eastern midnight", () => {
  const p = parseActionPages([sj18Actions]);
  const timed = p.rows.find((r) => r.metadata["action_time"] === "16:26:08" && r.metadata["action_code"] === "H37100");
  assert.ok(timed, "SJRES 18's House passage at 16:26:08 (the roll is stamped 20:26:08Z)");
  assert.equal(timed.action_at_eastern, "2025-04-09 16:26:08");
  assert.equal(timed.action_type, "Floor");
  assert.deepEqual(timed.metadata["recorded_votes"], [{ chamber: "House", roll_number: 96, session_number: 1, date: "2025-04-09T20:26:08Z" }]);
  const senate = p.rows.find((r) => (r.metadata["source_system"] as { name: string }).name === "Senate");
  assert.ok(senate);
  assert.match(senate.action_at_eastern, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
  assert.equal(senate.metadata["action_code"], undefined, "Senate actions carry no action code");
});

test("actionSourceKey: stable across a re-spaced text, different for a different text; an exact repeat is counted once", () => {
  const a = { actionDate: "2025-06-30", text: "Considered by Senate.", type: "Floor", sourceSystem: { name: "Senate" } };
  assert.equal(actionSourceKey(a), actionSourceKey({ ...a, text: "  Considered  by Senate. " }));
  assert.notEqual(actionSourceKey(a), actionSourceKey({ ...a, text: "Considered by Senate. (consideration: CR S1)" }));
  const p = parseActionPages([{ actions: [a, { ...a }, { ...a, actionDate: undefined }], pagination: { count: 3 } }]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.duplicateKey, 1);
  assert.equal(p.undated, 1);
});

// ── titles and the introduced date (D6) ─────────────────────────────────────

test("pickShortTitle: HR 1's whole-measure short title, not a portion's; none on SJRES 18", () => {
  assert.equal(pickShortTitle([hr1Titles]), "One Big Beautiful Bill Act");
  assert.equal(pickShortTitle([sj18Titles]), null);
});

test("decideTitle: fill an empty or number-only title; never overwrite a real one", () => {
  const src = "Strategic Production Response Act";
  assert.equal(decideTitle(null, "HR 21", src), "filled");
  assert.equal(decideTitle("  ", "HR 21", src), "filled");
  assert.equal(decideTitle("HR 21", "HR 21", src), "filled");
  assert.equal(decideTitle(src, "HR 21", src), "same");
  assert.equal(decideTitle("A stored title", "HR 21", src), "kept_differs");
  assert.equal(decideTitle("HR 21", "HR 21", null), "no_source");
  assert.equal(decideTitle("x".repeat(500), "HR 21", "x".repeat(600)), "same", "the column holds 500 characters");
});

test("decideIntroduced: set only when NULL", () => {
  assert.equal(decideIntroduced(null, "2025-05-20"), "filled");
  assert.equal(decideIntroduced("2025-05-20", "2025-05-20"), "same");
  assert.equal(decideIntroduced("2025-05-22", "2025-05-20"), "kept_differs");
  assert.equal(decideIntroduced(null, null), "no_source");
});
