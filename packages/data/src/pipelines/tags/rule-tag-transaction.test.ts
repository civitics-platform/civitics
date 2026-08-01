/**
 * FIX-949 / FIX-945 — the rule taggers' clear+upsert must be one transaction.
 *
 * What this covers, and what it deliberately does not: a fake client cannot
 * prove anything about SIGTERM, so the kill-safety property itself is proven by
 * running the real tagger against local Docker and killing it mid-upsert (the
 * FIX-917/920 convention — see the FIX-949 commit body for the count sets). What
 * IS unit-testable, and what regressed in prod, is the SHAPE:
 *
 *   - a failed clear must abort BEFORE any upsert runs. tagProposals and
 *     tagOfficials previously console.error'd the PostgREST `.delete()` error
 *     and then fell through into the upsert, writing the fresh set onto a table
 *     that was never cleared. That is the regression pinned below.
 *   - every statement must land on ONE client inside ONE BEGIN/COMMIT pair.
 *     upsertTags used to open its own connection via withDirectClient, so the
 *     chunks autocommitted outside whatever the clear had done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { runTagRebuildTransaction } from "./rules";
import { bulkUpsert } from "../../lib/direct-pg-upsert";

/** Records every statement issued, and can be told to reject one of them. */
function fakeClient(failOn?: (sql: string) => boolean) {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (failOn?.(text)) throw new Error(`simulated failure: ${text.slice(0, 24)}`);
      return { rows: [], rowCount: 0 };
    },
  };
  return { client: client as unknown as Client, sql };
}

const verbs = (sql: string[]) => sql.map((s) => s.trim().split(/\s+/)[0]!.toUpperCase());

test("happy path: BEGIN, body, COMMIT — body gets the same client", async () => {
  const { client, sql } = fakeClient();
  let sawClient: Client | null = null;

  const out = await runTagRebuildTransaction(client, async (c) => {
    sawClient = c;
    await c.query("DELETE FROM public.entity_tags WHERE entity_type = 'proposal'");
    return 42;
  });

  assert.equal(out, 42);
  assert.equal(sawClient, client, "the body must run on the transaction's own client");
  assert.deepEqual(verbs(sql), ["BEGIN", "DELETE", "COMMIT"]);
});

test("a failed clear aborts the rebuild — no upsert is issued, and it rolls back", async () => {
  // The FIX-949 regression, in the shape it shipped: the clear fails, and the
  // old code logged it and upserted anyway. Now it must throw out of the
  // transaction with the INSERT never attempted.
  const { client, sql } = fakeClient((s) => s.startsWith("DELETE"));

  await assert.rejects(
    runTagRebuildTransaction(client, async (c) => {
      await c.query("DELETE FROM public.entity_tags WHERE entity_type = 'official'");
      await c.query("INSERT INTO public.entity_tags (entity_type) VALUES ('official')");
      return 1;
    }),
    /simulated failure: DELETE/,
  );

  assert.deepEqual(verbs(sql), ["BEGIN", "DELETE", "ROLLBACK"]);
  assert.ok(
    !sql.some((s) => s.startsWith("INSERT")),
    "no upsert may run once the clear has failed",
  );
});

test("a failed upsert rolls back rather than committing a half-rebuild", async () => {
  const { client, sql } = fakeClient((s) => s.startsWith("INSERT"));

  await assert.rejects(
    runTagRebuildTransaction(client, async (c) => {
      await c.query("SELECT public.clear_financial_entity_rule_tags($1::text[])", [["industry"]]);
      await c.query("INSERT INTO public.entity_tags (entity_type) VALUES ('financial_entity')");
      return 1;
    }),
  );

  assert.deepEqual(verbs(sql), ["BEGIN", "SELECT", "INSERT", "ROLLBACK"]);
  assert.ok(!sql.includes("COMMIT"), "a failed upsert must never reach COMMIT");
});

test("ROLLBACK failing does not mask the original error", async () => {
  // A killed connection makes ROLLBACK itself throw; the server rolls back
  // anyway. The caller must still see why the rebuild failed.
  const { client } = fakeClient((s) => s === "ROLLBACK" || s.startsWith("DELETE"));

  await assert.rejects(
    runTagRebuildTransaction(client, (c) => c.query("DELETE FROM public.entity_tags")),
    /simulated failure: DELETE/,
  );
});

test("client threading: the real bulkUpsert's chunks land inside the same transaction", async () => {
  // The other half of FIX-949. upsertTags used to call withDirectClient itself,
  // so its chunks committed on a SEPARATE connection from the clear — which is
  // what made the 2026-07-30 kill destructive. Driving the real bulkUpsert here
  // proves it issues its INSERTs on the client it is handed, between BEGIN and
  // COMMIT, with no connection of its own.
  const { client, sql } = fakeClient();

  await runTagRebuildTransaction(client, async (c) => {
    await c.query("SELECT public.clear_financial_entity_rule_tags($1::text[])", [["industry"]]);
    await c.query("DELETE FROM public.entity_tags WHERE generated_by = 'curated'");
    return bulkUpsert(c, {
      table: "entity_tags",
      columns: ["entity_type", "entity_id", "tag", "tag_category"],
      conflictColumns: ["entity_type", "entity_id", "tag", "tag_category"],
      rows: [
        ["financial_entity", "a", "finance", "industry"],
        ["financial_entity", "b", "energy", "industry"],
        ["financial_entity", "c", "health", "industry"],
      ],
      chunkSize: 2, // force >1 chunk — each was its own autocommit before
    });
  });

  // Two chunks, both INSERTs, both between the BEGIN and the COMMIT.
  assert.deepEqual(verbs(sql), ["BEGIN", "SELECT", "DELETE", "INSERT", "INSERT", "COMMIT"]);
});
