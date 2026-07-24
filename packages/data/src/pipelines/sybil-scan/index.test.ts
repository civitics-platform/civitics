/**
 * FIX-571 PR2 — unit tests for the Sybil-scan runner's TS-side helpers.
 *
 * The scoring lives entirely in SQL (detect_sybil_clusters) and is proven by
 * supabase/tests/verify_fix571.sql. These tests pin the TS surface: arg parsing
 * (defaults + every flag), the prod-host guard, and the summary formatter — the
 * dry-run-vs-append decision hinges on parseArgs().dryRun.
 *
 * Runs via:  tsx --test src/pipelines/sybil-scan/index.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  hostFromUrl,
  isProdHost,
  summarizeCandidate,
  type Candidate,
} from "./index";

// parseArgs reads argv.slice(2), so mirror a real process.argv shape.
function argv(...rest: string[]): string[] {
  return ["node", "index.ts", ...rest];
}

test("parseArgs: defaults are the first-pass thresholds and LOCAL, non-prod, append mode", () => {
  // Guard against a stray SUPABASE_DB_URL in the ambient env skewing the default.
  const saved = process.env.SUPABASE_DB_URL;
  delete process.env.SUPABASE_DB_URL;
  try {
    const a = parseArgs(argv());
    assert.equal(a.dbUrl, "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    assert.equal(a.allowProd, false);
    assert.equal(a.dryRun, false);
    assert.equal(a.horizonDays, 30);
    assert.equal(a.minAccounts, 3);
    assert.equal(a.coupleMinutes, 15);
    assert.equal(a.burstMinutes, 60);
    assert.equal(a.dampCap, 25);
    assert.equal(a.scoreThreshold, 0.6);
  } finally {
    if (saved === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = saved;
  }
});

test("parseArgs: every flag overrides its default", () => {
  const a = parseArgs(
    argv(
      "--db-url", "postgresql://x/y",
      "--allow-prod",
      "--dry-run",
      "--horizon-days", "14",
      "--min-accounts", "5",
      "--couple-minutes", "10",
      "--burst-minutes", "30",
      "--damp-cap", "40",
      "--score-threshold", "0.75",
    ),
  );
  assert.equal(a.dbUrl, "postgresql://x/y");
  assert.equal(a.allowProd, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.horizonDays, 14);
  assert.equal(a.minAccounts, 5);
  assert.equal(a.coupleMinutes, 10);
  assert.equal(a.burstMinutes, 30);
  assert.equal(a.dampCap, 40);
  assert.equal(a.scoreThreshold, 0.75);
});

test("parseArgs: --dry-run alone flips only dryRun (the append-vs-print switch)", () => {
  assert.equal(parseArgs(argv()).dryRun, false);
  assert.equal(parseArgs(argv("--dry-run")).dryRun, true);
});

test("hostFromUrl: extracts host, tolerates garbage", () => {
  assert.equal(
    hostFromUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres"),
    "127.0.0.1:54322",
  );
  assert.equal(
    hostFromUrl("postgresql://postgres.xsazcoxinpgttgquwvuf@aws-0-us-west-2.pooler.supabase.com:5432/postgres"),
    "aws-0-us-west-2.pooler.supabase.com:5432",
  );
  assert.equal(hostFromUrl("not a url"), "unknown");
});

test("isProdHost: local Docker is NOT prod; any supabase.* URL IS", () => {
  const local = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  assert.equal(isProdHost(hostFromUrl(local), local), false);

  const pooler =
    "postgresql://postgres.ref@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
  assert.equal(isProdHost(hostFromUrl(pooler), pooler), true);

  const direct = "postgresql://postgres:pw@db.xsazcoxinpgttgquwvuf.supabase.co:5432/postgres";
  assert.equal(isProdHost(hostFromUrl(direct), direct), true);
});

test("summarizeCandidate: compacts a scorer row; null cluster_key renders as (none)", () => {
  const c: Candidate = {
    signal: "shared_fingerprint",
    cluster_key: "ip_farm|ua_farm",
    cluster_size: 3,
    account_ids: ["a", "b", "c"],
    event_count: 7,
    first_seen: null,
    last_seen: null,
    score: "0.8333",
    signals: { raw_score: 0.8333 },
  };
  assert.deepEqual(summarizeCandidate(c), {
    signal: "shared_fingerprint",
    size: 3,
    score: "0.8333",
    key: "ip_farm|ua_farm",
  });

  const nullKey = { ...c, cluster_key: null };
  assert.equal(summarizeCandidate(nullKey).key, "(none)");
});
