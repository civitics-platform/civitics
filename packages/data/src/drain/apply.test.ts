/**
 * FIX-890 — regression tests for the drain tag write path.
 *
 * Covers the two behaviours that let FIX-889 happen and would have let it
 * recur: the per-tag `tag_category` (a complexity tag must land as `quality`,
 * not `topic`) and the write-boundary vocabulary guard (an out-of-vocab tag is
 * rejected and counted, not inserted).
 *
 * Runs against a stub `db` — no local Docker, no network. `applyResult` takes
 * `db: any`, so the stub only has to implement the handful of PostgREST
 * builder chains the function actually calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResult } from "./apply";

type UpsertedRow = {
  entity_type: string;
  entity_id: string;
  tag: string;
  tag_category: string;
  [k: string]: unknown;
};

type QueueRow = {
  id: number;
  task_type: "tag" | "summary";
  entity_id: string;
  entity_type: string;
};

/** Records what applyResult tried to write, and to where. */
function makeDb(queueRow: QueueRow | null) {
  const upserted: UpsertedRow[] = [];
  const failures: Array<{ queue_id: number; error: string }> = [];
  let markedDone = false;

  const db = {
    from(table: string) {
      if (table === "enrichment_queue") {
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                queueRow ? { data: queueRow, error: null } : { data: null, error: new Error("no row") },
            }),
          }),
          update: () => ({
            eq: async () => {
              markedDone = true;
              return { error: null };
            },
          }),
        };
      }
      if (table === "entity_tags") {
        return {
          upsert: async (rows: UpsertedRow[]) => {
            upserted.push(...rows);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "record_enrichment_failure") {
        failures.push({
          queue_id: args["p_queue_id"] as number,
          error: args["p_error"] as string,
        });
      }
      return { data: null, error: null };
    },
  };

  return { db, upserted, failures, markedDone: () => markedDone };
}

const PROPOSAL_QUEUE_ROW: QueueRow = {
  id: 4242,
  task_type: "tag",
  entity_id: "11111111-1111-1111-1111-111111111111",
  entity_type: "proposal",
};

test("complexity tag lands as tag_category='quality', topic tag as 'topic'", async () => {
  const { db, upserted, failures } = makeDb(PROPOSAL_QUEUE_ROW);

  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: {
      tags: [
        { tag: "climate", tag_category: "topic", confidence: 0.9, is_primary: true, rank: 1 },
        { tag: "technical", tag_category: "quality", confidence: 1.0 },
      ],
      model: "claude-haiku-4-5-20251001",
      pipeline_version: "drain-v1",
    },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(failures.length, 0);
  assert.equal(upserted.length, 2);

  const byTag = new Map(upserted.map((r) => [r.tag, r]));
  // The FIX-889 assertion: complexity is NOT a topic.
  assert.equal(byTag.get("technical")?.tag_category, "quality");
  assert.equal(byTag.get("climate")?.tag_category, "topic");
});

test("out-of-vocab tag is rejected, counted, and never upserted", async () => {
  const { db, upserted, failures } = makeDb(PROPOSAL_QUEUE_ROW);

  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: {
      tags: [
        { tag: "climate", tag_category: "topic", confidence: 0.9 },
        // Invented by the worker — exactly how `justice` / `small_business`
        // reached prod before the guard existed.
        { tag: "wildly_invented_topic", tag_category: "topic", confidence: 0.9 },
      ],
      model: "claude-haiku-4-5-20251001",
    },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.rejected : -1, 1);
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0]?.tag, "climate");
  assert.equal(failures.length, 0);
});

test("guard checks the (category, tag) pair — 'technical' as a topic is rejected", async () => {
  const { db, upserted } = makeDb(PROPOSAL_QUEUE_ROW);

  // The literal FIX-889 payload: a complexity tag mislabelled as a topic. The
  // tag string is legal; the pairing is not.
  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: {
      tags: [
        { tag: "housing", tag_category: "topic", confidence: 0.9 },
        { tag: "technical", tag_category: "topic", confidence: 1.0 },
      ],
    },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.rejected : -1, 1);
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0]?.tag, "housing");
});

test("legacy result with no tag_category falls back to the per-entity-type derivation", async () => {
  const { db, upserted } = makeDb(PROPOSAL_QUEUE_ROW);

  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: { tags: [{ tag: "housing", confidence: 0.9 }] },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0]?.tag_category, "topic");
});

test("financial_entity legacy fallback still derives 'industry'", async () => {
  const { db, upserted } = makeDb({
    id: 77,
    task_type: "tag",
    entity_id: "22222222-2222-2222-2222-222222222222",
    entity_type: "financial_entity",
  });

  const outcome = await applyResult(db, {
    queue_id: 77,
    success: true,
    result: { tags: [{ tag: "pharma", confidence: 0.9, is_primary: true, rank: 1 }] },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(upserted[0]?.tag_category, "industry");
});

test("all tags rejected -> failure recorded, queue row NOT marked done", async () => {
  const { db, upserted, failures, markedDone } = makeDb(PROPOSAL_QUEUE_ROW);

  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: { tags: [{ tag: "not_a_real_topic", tag_category: "topic", confidence: 0.9 }] },
  });

  assert.equal(outcome.kind, "fail");
  assert.equal(outcome.kind === "fail" ? outcome.rejected : -1, 1);
  assert.equal(upserted.length, 0);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.error, /rejected by vocabulary guard/);
  // Critical: a fully-rejected item must not silently complete.
  assert.equal(markedDone(), false);
});

test("aviation is in-vocabulary after FIX-889 adopted it", async () => {
  const { db, upserted } = makeDb(PROPOSAL_QUEUE_ROW);

  const outcome = await applyResult(db, {
    queue_id: 4242,
    success: true,
    result: { tags: [{ tag: "aviation", tag_category: "topic", confidence: 0.9 }] },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.kind === "ok" ? outcome.rejected : -1, 0);
  assert.equal(upserted[0]?.tag_category, "topic");
});

test("unknown entity_type fails open (writes + warns) rather than discarding", async () => {
  const { db, upserted } = makeDb({
    id: 99,
    task_type: "tag",
    entity_id: "33333333-3333-3333-3333-333333333333",
    entity_type: "agency",
  });

  const outcome = await applyResult(db, {
    queue_id: 99,
    success: true,
    result: { tags: [{ tag: "anything_at_all", tag_category: "topic", confidence: 0.9 }] },
  });

  assert.equal(outcome.kind, "ok");
  assert.equal(upserted.length, 1);
});
