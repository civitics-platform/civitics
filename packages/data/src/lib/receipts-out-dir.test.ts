/**
 * FIX-1209 — the three cases the receipts path resolver has to get right.
 *
 * The bug was never a wrong-looking path. It was that two runs against two
 * DIFFERENT databases resolved to one path, so the local one overwrote the
 * prod one and the diff looked intentional. So the assertions are about which
 * runs share a path and which do not, not about the string itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LOCAL_SUBDIR, isLocalDsn, receiptsOutDir } from "./receipts-out-dir";

const BASE = join("C:", "repo", "docs", "receipts");

test("local + no --out is redirected under local/", () => {
  const out = receiptsOutDir(BASE, { local: true, outGiven: false });
  assert.equal(out, join(BASE, LOCAL_SUBDIR));
  assert.notEqual(out, BASE, "a redirected run must not share the prod path");
});

test("local + an explicit --out is taken verbatim", () => {
  // An operator who names a directory means that directory — FIX-1198's rule.
  const named = join("C:", "tmp", "somewhere");
  assert.equal(receiptsOutDir(named, { local: true, outGiven: true }), named);
});

test("prod + no --out keeps the canonical path — the :ci path is untouched", () => {
  assert.equal(receiptsOutDir(BASE, { local: false, outGiven: false }), BASE);
});

test("the prod default and the local default cannot collide", () => {
  const prod = receiptsOutDir(BASE, { local: false, outGiven: false });
  const local = receiptsOutDir(BASE, { local: true, outGiven: false });
  assert.notEqual(prod, local, "this equality IS the bug FIX-1209 fixes");
});

test("isLocalDsn recognises the Docker DSN and rejects the pooler", () => {
  assert.equal(isLocalDsn("postgresql://postgres:postgres@127.0.0.1:54322/postgres"), true);
  assert.equal(isLocalDsn("postgresql://postgres:pw@localhost:54322/postgres"), true);
  assert.equal(
    isLocalDsn("postgresql://postgres.xsazcoxinpgttgquwvuf:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres"),
    false,
  );
  assert.equal(
    isLocalDsn("postgresql://postgres:pw@db.xsazcoxinpgttgquwvuf.supabase.co:5432/postgres"),
    false,
  );
});

test("a password containing '127.0.0.1' does not make a prod DSN look local", () => {
  // The host is what decides, so the match is anchored on the @ that ends the
  // credentials — a userinfo field can contain anything.
  assert.equal(
    isLocalDsn("postgresql://postgres:127.0.0.1@db.xsazcoxinpgttgquwvuf.supabase.co:5432/postgres"),
    false,
  );
});
