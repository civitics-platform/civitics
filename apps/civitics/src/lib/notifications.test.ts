/**
 * FIX-1205 — createNotification() surfaces a failed insert.
 *
 * It used to `await db.from("notifications").insert(...)` and drop the
 * `{ error }`, so a row the database refused (an enum value the column does
 * not know, an FK or RLS miss) vanished without a log line. Now it throws, and
 * both callers' best-effort try/catch logs it. The client is injected so the
 * error path runs without a database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotification, type NotificationInsertClient } from "./notifications";

function fakeClient(result: { error: { message: string; code?: string } | null }) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db: NotificationInsertClient = {
    from: (table) => ({
      insert: (row) => {
        inserted.push({ table, row });
        return Promise.resolve(result);
      },
    }),
  };
  return { db, inserted };
}

const ARGS = {
  userId: "11111111-1111-1111-1111-111111111111",
  eventType: "claim_outcome" as const,
  title: "Your access was revoked",
  body: "Your official access to Jane Doe has been revoked by an administrator.",
  link: "/officials/22222222-2222-2222-2222-222222222222",
  entityType: "official" as const,
  entityId: "22222222-2222-2222-2222-222222222222",
};

test("FIX-1205: a failed insert THROWS, naming the recipient, the event and the database's message", async () => {
  const { db } = fakeClient({ error: { message: 'invalid input value for enum notification_event_type: "claim_revoked"', code: "22P02" } });
  await assert.rejects(createNotification(ARGS, db), (err: Error) => {
    assert.match(err.message, /notifications insert failed/);
    assert.match(err.message, /11111111-1111-1111-1111-111111111111/);
    assert.match(err.message, /claim_outcome/);
    assert.match(err.message, /\[22P02\]/);
    assert.match(err.message, /invalid input value for enum/);
    return true;
  });
});

test("FIX-1205: a successful insert resolves and writes exactly the notifications row", async () => {
  const { db, inserted } = fakeClient({ error: null });
  await createNotification(ARGS, db);
  assert.deepEqual(inserted, [
    {
      table: "notifications",
      row: {
        user_id: ARGS.userId,
        event_type: "claim_outcome",
        title: ARGS.title,
        body: ARGS.body,
        link: ARGS.link,
        entity_type: "official",
        entity_id: ARGS.entityId,
      },
    },
  ]);
});

test("FIX-1205: optional fields are written as NULL, not undefined", async () => {
  const { db, inserted } = fakeClient({ error: null });
  await createNotification({ userId: ARGS.userId, eventType: "claim_outcome", title: "t" }, db);
  const row = inserted[0]!.row;
  assert.equal(row.body, null);
  assert.equal(row.link, null);
  assert.equal(row.entity_type, null);
  assert.equal(row.entity_id, null);
});
