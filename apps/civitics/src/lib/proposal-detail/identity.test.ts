/**
 * FIX-1447 (cc-317 D5, D6, D7) — identity line, metadata title, latest action,
 * source link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chamberLabel, identityLine, latestAction, metadataTitle, ordinal, sourceLink, type BillDetails } from "./identity";

const bd = (over: Partial<BillDetails> = {}): BillDetails => ({
  bill_number: "HR 1",
  chamber: "house",
  congress_number: 119,
  congress_gov_url: "https://www.congress.gov/bill/119th-congress/house-bill/1",
  ...over,
});

test("ordinal", () => {
  const cases: [number, string][] = [[1, "1st"], [2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"],
    [13, "13th"], [21, "21st"], [101, "101st"], [111, "111th"], [112, "112th"], [113, "113th"], [119, "119th"], [122, "122nd"]];
  for (const [n, want] of cases) assert.equal(ordinal(n), want, String(n));
});

test("D5: the federal line is number · ordinal Congress · chamber", () => {
  assert.equal(identityLine(bd(), {}), "HR 1 · 119th Congress · House");
  assert.equal(identityLine(bd({ bill_number: "PN 858", chamber: "senate" }), {}), "PN 858 · 119th Congress · Senate");
  assert.equal(identityLine(bd({ chamber: null }), {}), "HR 1 · 119th Congress");
  assert.equal(chamberLabel("council"), null);
});

test("D5: OpenStates is number · state; Legistar is its file number; else nothing", () => {
  assert.equal(
    identityLine(bd({ bill_number: "SB 185", chamber: "senate", congress_number: null }), { state: "DE" }),
    "SB 185 · DE",
  );
  assert.equal(
    identityLine(bd({ bill_number: "CB 119913", chamber: "council", congress_number: null }), { file_number: "CB 119913" }),
    "CB 119913",
  );
  assert.equal(identityLine(null, { court: "ca9" }), null);
  assert.equal(identityLine(null, null), null);
});

test("D5: the metadata title leads with the number unless the title is the number", () => {
  assert.equal(metadataTitle("One Big Beautiful Bill Act", bd()), "HR 1 — One Big Beautiful Bill Act");
  assert.equal(metadataTitle("HR 1", bd()), "HR 1");
  assert.equal(metadataTitle("H.R. 1", bd()), "H.R. 1");
  assert.equal(metadataTitle("A regulation", null), "A regulation");
  assert.equal(metadataTitle("Something", bd({ bill_number: " " })), "Something");
});

test("D6: the latest action is metadata.latest_action with last_action_at, never a date alone", () => {
  assert.deepEqual(latestAction({ latest_action: "Became Public Law No: 119-21." }, "2025-07-04"), {
    text: "Became Public Law No: 119-21.",
    date: "July 4, 2025",
  });
  assert.deepEqual(latestAction({ latest_action: "Referred." }, null), { text: "Referred.", date: null });
  assert.deepEqual(latestAction({ latest_action: { text: "Signed" } }, "2025-01-02"), { text: "Signed", date: "January 2, 2025" });
  assert.equal(latestAction({}, "2025-07-04"), null);
  assert.equal(latestAction({ latest_action: "  " }, "2025-07-04"), null);
  assert.equal(latestAction(null, null), null);
});

test("D7: congress.gov URL first, else external_url; the label follows the host", () => {
  assert.deepEqual(sourceLink({ congressGovUrl: bd().congress_gov_url, externalUrl: "https://example.org/x" }), {
    href: "https://www.congress.gov/bill/119th-congress/house-bill/1",
    label: "View on congress.gov ↗",
  });
  assert.deepEqual(sourceLink({ congressGovUrl: null, externalUrl: "https://congress.gov/nomination/119th-congress/858" }), {
    href: "https://congress.gov/nomination/119th-congress/858",
    label: "View on congress.gov ↗",
  });
  assert.deepEqual(sourceLink({ congressGovUrl: " ", externalUrl: "https://seattle.legistar.com/x" }), {
    href: "https://seattle.legistar.com/x",
    label: "View source ↗",
  });
  // A look-alike host is not congress.gov.
  assert.equal(sourceLink({ congressGovUrl: "https://notcongress.gov.example.com/a", externalUrl: null })?.label, "View source ↗");
});

test("D7: nothing for no URL, a non-http URL, or a link the row already prints", () => {
  assert.equal(sourceLink({ congressGovUrl: null, externalUrl: null }), null);
  assert.equal(sourceLink({ congressGovUrl: null, externalUrl: "javascript:alert(1)" }), null);
  assert.equal(sourceLink({ congressGovUrl: null, externalUrl: "not a url" }), null);
  assert.equal(
    sourceLink({
      congressGovUrl: null,
      externalUrl: "https://www.regulations.gov/document/EPA-1/",
      alreadyLinked: ["https://www.regulations.gov/document/EPA-1"],
    }),
    null,
  );
});
