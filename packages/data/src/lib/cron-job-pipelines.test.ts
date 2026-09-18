/**
 * FIX-1190 — the job → pipeline derivation, tested at the level it can be.
 *
 * The query itself needs a database, so what is testable here is (a) that the
 * literal patterns match the two forms that exist in the tree and reject a
 * commented-out one, and (b) that the receipts query is KEYED on this
 * derivation rather than on the clock. (b) is a string assertion on purpose: it
 * is the only thing that fails if someone restores the old time-first join,
 * and restoring it is the regression FIX-1190 is about.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  Q_CRON_JOB_PIPELINES,
  Q_GUARDED_PIPELINES,
  RE_COMMENT_ONLY_LINE,
  RE_PIPELINE_FROM_INSERT,
  RE_PIPELINE_FROM_LOCAL,
  RE_PROC_FROM_COMMAND,
  sqlRegexToJs,
} from "./cron-job-pipelines";

/**
 * `Q_CRON_JOBS` is read as TEXT, not imported.
 *
 * `receipts-daily.ts` calls `main()` at module scope — it is a CLI, not a
 * library — so importing it from a test would run the script and open a
 * database connection. Reading the source is also the more honest instrument
 * for what the last four tests assert: they are about what the query text
 * says, and a text read cannot be satisfied by anything but the text.
 */
const Q_CRON_JOBS = ((): string => {
  const src = readFileSync(new URL("../scripts/receipts-daily.ts", import.meta.url), "utf8");
  const m = /const Q_CRON_JOBS = `([^`]*)`;/.exec(src);
  assert.ok(m, "Q_CRON_JOBS not found in receipts-daily.ts");
  return m[1]!;
})();

const INSERT_RE = sqlRegexToJs(RE_PIPELINE_FROM_INSERT);
const LOCAL_RE = sqlRegexToJs(RE_PIPELINE_FROM_LOCAL);
const PROC_RE = sqlRegexToJs(RE_PROC_FROM_COMMAND);
const COMMENT_RE = sqlRegexToJs(RE_COMMENT_ONLY_LINE, "g");

/** The comment strip the query applies before the literal regexes run. */
function strip(body: string): string {
  return body.replace(sqlRegexToJs(RE_COMMENT_ONLY_LINE, "gi"), "");
}

function pipelineOf(body: string): string | null {
  const b = strip(body);
  return INSERT_RE.exec(b)?.[1] ?? LOCAL_RE.exec(b)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The two literal forms
// ---------------------------------------------------------------------------

test("the INSERT form resolves — the shape 25 of 26 cron procedures use", () => {
  assert.equal(
    pipelineOf(`
      INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
      VALUES ('official_vote_stats_rebuild', 'running', now(), v_meta);
    `),
    "official_vote_stats_rebuild",
  );
});

test("the INSERT form resolves across a line break inside the column list", () => {
  // `refresh_derived_mvs` wraps its column list. `[^)]*` has to span newlines,
  // which in a POSIX ARE it does — this is the assertion that says so.
  assert.equal(
    pipelineOf(`
      INSERT INTO public.data_sync_log
        (pipeline, status,
         started_at)
      VALUES ('refresh_derived_mvs', 'running', now());
    `),
    "refresh_derived_mvs",
  );
});

test("the local-variable form resolves — donor_rollup_rebuild_bulk's shape", () => {
  assert.equal(
    pipelineOf(`
      DECLARE
        c_pipeline text := 'donor_rollup_refresh';
      BEGIN
        INSERT INTO public.data_sync_log (pipeline, status) VALUES (c_pipeline, 'running');
    `),
    "donor_rollup_refresh",
  );
});

test("the INSERT form WINS when a procedure carries both", () => {
  // COALESCE order, asserted: a literal INSERT is the more direct evidence.
  assert.equal(
    pipelineOf(`
      c_pipeline text := 'wrong_one';
      INSERT INTO public.data_sync_log (pipeline) VALUES ('right_one');
    `),
    "right_one",
  );
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

test("a COMMENTED-OUT literal does not resolve", () => {
  // No procedure carries one today (checked on the clone 2026-09-18 — the five
  // comment lines mentioning data_sync_log are all prose). The regexes have no
  // comment awareness of their own, so the strip is what makes that safe, and
  // this is the test that keeps the strip.
  assert.equal(
    pipelineOf(`
      -- INSERT INTO public.data_sync_log (pipeline) VALUES ('dead_pipeline');
      RETURN;
    `),
    null,
  );
  assert.equal(pipelineOf(`      -- c_pipeline text := 'dead_pipeline';\n`), null);
});

test("a commented literal does not mask a live one further down", () => {
  assert.equal(
    pipelineOf(`
      -- was: INSERT INTO public.data_sync_log (pipeline) VALUES ('old_name');
      INSERT INTO public.data_sync_log (pipeline) VALUES ('new_name');
    `),
    "new_name",
  );
});

test("an INLINE trailing comment survives the strip, and does not block a literal past it", () => {
  // Only comment-ONLY lines are stripped, so this comment is still in the body
  // when the regexes run. It sits outside the matched span, so it is harmless.
  assert.equal(
    pipelineOf(`
      -- FIX-950 guarded
      INSERT INTO public.data_sync_log (pipeline) VALUES ('run_rule_taggers');  -- one row
    `),
    "run_rule_taggers",
  );
});

/**
 * THE KNOWN LIMIT, asserted so it is a decision and not a surprise.
 *
 * An inline comment INSIDE the matched span — between the column list and
 * `VALUES` — breaks the match, because the pattern's inter-token gaps are
 * `\s*` and a comment is not whitespace. No cron-called procedure has that
 * shape (checked on the clone 2026-09-18: all 26 resolve).
 *
 * It is left as a NULL rather than fixed with a blanket comment strip, and the
 * reason is which way each option fails. A blanket strip would silently eat a
 * `--` inside a string literal — a `skip_reason` reading "held -- see FIX-nnn"
 * would truncate the body mid-statement and could resolve the WRONG pipeline.
 * This resolves NO pipeline, which renders `—` in the receipts table and sends
 * the verdict to the cron status alone. A visible missing correlation beats an
 * invisible wrong one, which is the whole lesson of FIX-1190.
 */
test("KNOWN LIMIT: a comment between the column list and VALUES resolves NULL, not a wrong name", () => {
  assert.equal(
    pipelineOf(`
      INSERT INTO public.data_sync_log (pipeline)   -- FIX-950 guarded
      VALUES ('run_rule_taggers');
    `),
    null,
  );
});

test("a procedure that writes no data_sync_log row resolves NULL", () => {
  assert.equal(pipelineOf("BEGIN DELETE FROM public.abuse_events WHERE observed_at < now(); END"), null);
});

test("the comment-only pattern is anchored per line, not to the whole body", () => {
  const body = "  -- a comment\nSELECT 1;\n    -- another\n";
  assert.equal(strip(body).replace(/\n+/g, "\n").trim(), "SELECT 1;");
  assert.ok(COMMENT_RE.test("   -- yes"));
});

// ---------------------------------------------------------------------------
// The command → procedure pattern
// ---------------------------------------------------------------------------

test("the command pattern reads CALL and SELECT, schema-qualified or not", () => {
  assert.equal(PROC_RE.exec("CALL public.run_rule_taggers();")?.[1], "run_rule_taggers");
  assert.equal(PROC_RE.exec("SELECT refresh_platform_counts();")?.[1], "refresh_platform_counts");
  assert.equal(PROC_RE.exec("call  public.donor_rollup_rebuild_bulk( 12 )")?.[1], "donor_rollup_rebuild_bulk");
});

test("a bare VACUUM command resolves no procedure — the twelve vacuum jobs", () => {
  assert.equal(PROC_RE.exec("VACUUM (ANALYZE) public.entity_connections;"), null);
});

// ---------------------------------------------------------------------------
// The receipts query is keyed on the derivation, not the clock
// ---------------------------------------------------------------------------

test("FIX-1190: Q_CRON_JOBS keys the data_sync_log join on the DERIVED pipeline", () => {
  assert.ok(Q_CRON_JOBS.includes("l.pipeline = jp.pipeline"), "the key must be the derived pipeline");
  assert.ok(Q_CRON_JOBS.includes("WITH jp AS ("), "the derivation CTE must be spliced in");
  assert.ok(
    Q_CRON_JOBS.includes("AND jp.pipeline IS NOT NULL"),
    "a pipeline-less job must correlate to nothing BY CONSTRUCTION",
  );
});

test("FIX-1190: the old time-first name tiebreak is gone and stays gone", () => {
  // This is the whole point of a structural test. `replace(j.jobname, '-', '_')`
  // was the tiebreak that let ec-vacuum-analyze inherit ec_crawl's skip; if it
  // ever comes back, this fails before a receipts file is written.
  assert.ok(
    !Q_CRON_JOBS.includes("replace(j.jobname"),
    "the jobname-as-pipeline tiebreak must not be restored",
  );
});

test("Q_CRON_JOBS still bounds the correlation by the ±90 s window", () => {
  // Kept as the DISAMBIGUATOR for the four shared pipelines, not as the key.
  assert.ok(Q_CRON_JOBS.includes("interval '90 seconds'"));
  assert.ok(Q_CRON_JOBS.includes("l.metadata->>'source' LIKE 'pg_cron%'"));
});

test("Q_GUARDED_PIPELINES filters the shared derivation, never a hand-written list", () => {
  assert.ok(Q_GUARDED_PIPELINES.includes(Q_CRON_JOB_PIPELINES));
  assert.ok(Q_GUARDED_PIPELINES.includes("WHERE guarded AND pipeline IS NOT NULL"));
});
