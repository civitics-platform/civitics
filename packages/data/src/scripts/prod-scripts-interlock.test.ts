/**
 * FIX-1174 — every operator-run `:prod` WRITER claims the supervised session.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. FIX-950 wrapped the five FR-rewrite
 * landings because they were the scripts in front of it at the time. Twenty-odd
 * other `:prod` entries write to production and claimed nothing, and the only
 * thing that would have caught a twenty-first was somebody remembering. The
 * census this replaces was a grep run by hand once, in a prompt, against a
 * package.json that gains entries.
 *
 * THE RULE. Every key in `packages/data/package.json` ending `:prod` either
 *
 *   (a) names a script file whose source contains `runUnderProdSession(` —
 *       or `withProdSession(`, the same claim scoped to the writing part of a
 *       main() that waits on prod_op_gate() first (FIX-1215) — or
 *   (b) appears in READ_ONLY below with a one-line reason.
 *
 * A new `:prod` writer added without the wrapper fails here. A new `:prod`
 * entry that is neither wrapped nor allowlisted fails with a message naming
 * both options, because "which of the two did you mean" is the whole question
 * and an error that does not ask it gets answered by deleting the test.
 *
 * WHAT IS DELIBERATELY NOT THE HOOK. `--allow-prod` is the `createAdminClient`
 * guard and stays that. Keying the interlock on it would put a session claim on
 * the scheduled `:ci` pipelines, which carry the flag — a nightly that claims
 * the interlock is a nightly that REFUSES itself, and the interlock exists to
 * let an operator hold the box against the nightly, not the other way round.
 *
 * THE ALLOWLIST IS AUDITED, NOT TRUSTED. Every entry in it must still exist in
 * package.json, so a renamed or deleted script cannot leave a stale exemption
 * standing for a name nothing runs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PKG_PATH = fileURLToPath(new URL("../../package.json", import.meta.url));
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * `:prod` entries that read and never write, entry by entry with the reason.
 *
 * Keyed on the ENTRY rather than the file on purpose: `donor-rollup-sweep.ts`
 * is a writer AND has a `--status` mode that is a read, and only the entry
 * distinguishes them. (Those three still contain the wrapper, so they would
 * pass the assertion anyway — they are listed because the reason is worth
 * writing down where the next person adds a mode.)
 */
const READ_ONLY: Record<string, string> = {
  "data:fec:resume-status:prod":
    "reads pipeline_state + data_sync_log through supabase-js; no write call of any kind",
  "data:audit:fec-residue:prod":
    "FIX-1106 anti-join; builds a TSV manifest, deletes nothing",
  "data:audit:fec-attribution:prod":
    "FIX-930 enumeration; runs inside BEGIN TRANSACTION READ ONLY",
  "data:audit-summary-context:prod":
    "counts summary-context levels over proposals; select-only through supabase-js",
  "diag:gb-membership:prod":
    "FIX-470 membership audit; sets default_transaction_read_only = on first",
  "data:receipts:daily:prod":
    "FIX-1176 standing reads; sets default_transaction_read_only = on before anything else",
  "data:census:cancellations:prod":
    "Logs API only; opens no Postgres connection",
  "data:donor-rollup:status:prod":
    "--status mode of a wrapped writer: reports the sweep cursor and exits",
  "data:donor-rollup:bulk:status:prod":
    "--status mode of a wrapped writer: reports the sweep cursor and exits",
  "data:treemap:status:prod":
    "--status mode of a wrapped writer: reports the chunk cursor and exits",
};

/** Every `:prod` entry, with the script file its command runs. */
function prodEntries(): Array<{ key: string; cmd: string; file: string | null }> {
  return Object.entries(PKG.scripts)
    .filter(([k]) => k.endsWith(":prod"))
    .map(([key, cmd]) => {
      const m = /(src\/scripts\/[A-Za-z0-9._-]+\.ts)/.exec(cmd);
      return { key, cmd, file: m ? m[1]! : null };
    });
}

function sourceOf(file: string): string {
  return readFileSync(fileURLToPath(new URL("../../" + file, import.meta.url)), "utf8");
}

/**
 * The assertion, as a pure function, so the failure case can be exercised
 * against a fabricated entry rather than only against the tree (rule 105 — a
 * guard nobody has watched fail is a guard nobody knows is wired up).
 */
export function interlockVerdict(
  key: string,
  file: string | null,
  src: string,
  readOnly: Readonly<Record<string, string>> = READ_ONLY,
): { ok: boolean; reason: string } {
  if (key in readOnly) return { ok: true, reason: `read-only: ${readOnly[key]}` };
  if (file === null) return { ok: false, reason: "no src/scripts/*.ts in the command" };
  // FIX-1215: withProdSession( is the same claim, scoped to the part of main()
  // that writes. A runner that WAITS for prod_op_gate() first must claim AFTER
  // the wait, not around it (rule 102), so it cannot wrap its whole main().
  if (src.includes("runUnderProdSession(") || src.includes("withProdSession(")) {
    return { ok: true, reason: "wrapped" };
  }
  return {
    ok: false,
    reason:
      `${key} runs ${file} against production and does not claim the supervised ` +
      `prod session. Either wrap its entry point — ` +
      `runUnderProdSession({ script: "<name>", expectedMinutes: N }, main) — or, if it ` +
      `only reads, add it to READ_ONLY in this file with a one-line reason. ` +
      `Do NOT key the interlock on --allow-prod: the scheduled :ci pipelines carry ` +
      `that flag and would self-lock.`,
  };
}

test("every :prod entry is either wrapped or an audited read", () => {
  const failures: string[] = [];
  for (const { key, file } of prodEntries()) {
    const src = file ? sourceOf(file) : "";
    const v = interlockVerdict(key, file, src);
    if (!v.ok) failures.push(v.reason);
  }
  assert.deepEqual(failures, [], failures.join("\n\n"));
});

test("the census finds the :prod entries at all", () => {
  // A guard on the guard: if the key suffix or the command shape drifts, the
  // test above passes over an empty list and asserts nothing.
  const entries = prodEntries();
  assert.ok(entries.length >= 40, `only ${entries.length} :prod entries found`);
  assert.ok(
    entries.every((e) => e.file !== null),
    "a :prod entry runs no src/scripts/*.ts file — the command shape has changed",
  );
});

test("no allowlist entry outlives its package.json key", () => {
  const live = new Set(prodEntries().map((e) => e.key));
  const stale = Object.keys(READ_ONLY).filter((k) => !live.has(k));
  assert.deepEqual(
    stale,
    [],
    `READ_ONLY exempts ${stale.join(", ")}, which package.json no longer defines. ` +
      `A stale exemption is how a renamed writer walks back in unwrapped.`,
  );
});

test("an unwrapped, unlisted :prod entry FAILS, and the message names both options", () => {
  // The red case. Without it, a verdict function that returned ok:true for
  // everything would satisfy every other test in this file.
  const v = interlockVerdict("data:made-up:prod", "src/scripts/made-up.ts", "async function main() {}\nmain();");
  assert.equal(v.ok, false);
  assert.match(v.reason, /runUnderProdSession/);
  assert.match(v.reason, /READ_ONLY/);
  assert.match(v.reason, /--allow-prod/);
});

test("withProdSession( counts as the claim (FIX-1215: claim after the gate wait, not around it)", () => {
  const v = interlockVerdict("data:made-up:prod", "src/scripts/made-up.ts",
    "await waitForProdOpGate(o);\nawait withProdSession({ reason }, loop);");
  assert.equal(v.ok, true);
});

test("an allowlisted entry passes even with no wrapper in its source", () => {
  const v = interlockVerdict("data:receipts:daily:prod", "src/scripts/x.ts", "");
  assert.equal(v.ok, true);
  assert.match(v.reason, /read_only|read-only/);
});

test("the six FIX-950 landings are still wrapped", () => {
  // Named rather than counted: FIX-950's five plus restore-fec-ids were the
  // set before FIX-1174, and a refactor that unwraps one of them should not be
  // absorbed by the general rule passing on a different file.
  for (const f of [
    "merge-same-person-official-dupes.ts",
    "remediate-bound-cross-person.ts",
    "remediate-cross-person-misattribution.ts",
    "remediate-fec-emit-residue.ts",
    "remediate-role-ineligible-holders.ts",
    "restore-fec-ids.ts",
  ]) {
    assert.ok(
      sourceOf("src/scripts/" + f).includes("runUnderProdSession("),
      `${f} lost its prod-session claim`,
    );
  }
});

test("--status bypasses the claim in all three dual-mode sweeps", () => {
  // The other half of the READ_ONLY reasoning: the file is wrapped, and the
  // read mode must still be runnable while somebody else holds the box.
  for (const f of ["donor-rollup-sweep.ts", "donor-rollup-bulk.ts", "treemap-global-sweep.ts"]) {
    const src = sourceOf("src/scripts/" + f);
    assert.ok(src.includes("runUnderProdSession("), `${f} must claim the session to write`);
    assert.match(
      src,
      /STATUS_ONLY\s*\n?\s*\?\s*run\(\)/,
      `${f}: --status must run main() directly. A read that claims the interlock holds ` +
        `the guarded pipelines and refuses under another session, which makes the ` +
        `cheapest check the one you cannot run when you need it.`,
    );
  }
});
