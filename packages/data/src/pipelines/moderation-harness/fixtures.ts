// SF-P3 shadow moderation harness (FIX-601) — the F1–F12 casebook fixtures.
//
// Each fixture is run by the harness INSIDE a transaction that is rolled back.
// It instantiates minimal synthetic bad behavior, exercises the LIVE moderation
// rule, and returns the computed verdict. It writes nothing that survives the
// rollback and confers no consequence.
//
// Expected verdicts are grounded in state-of-franklin-bible §11.1 and re-verified
// against the live SQL (FIX-601 investigation):
//   - autotrip          → entity_comments_flag_autotrip()        (20260607050000)
//   - citation / tier    → add_evidence_card()                    (20260614000100)
//   - comment cap        → submit_comment()                       (20260609000000)
//   - position cap/halve → set_entity_position()                  (20260613000000)
//   - bridge scorer      → recompute_comment_bridge_scores()      (20260618000000)
//   - corroboration      → count_independent_corroborations()     (20260614010000)

import { randomUUID } from "node:crypto";
import type { Fixture, TxContext } from "./types";

const VALID_BODY = "this is a valid casebook fixture comment body";

// Probe whether a brigade/coordination detector exists at all. The GAP fixtures
// (F8/F9) compute their "not detected" verdict from this — honest, not assumed.
async function detectorExists(
  tx: TxContext,
  ...needles: string[]
): Promise<boolean> {
  const rows = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public'
        AND (${needles.map((_, i) => `p.proname ILIKE $${i + 1}`).join(" OR ")})`,
    needles.map((n) => `%${n}%`),
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

// Create an ephemeral, NON-synthetic user with an explicit account age (the
// `created_at` is the brigade detector's established-vs-new discriminator).
// Rolled back with the txn. Used by the SF-P4 fixtures (F8N / F9).
async function createAgedUser(tx: TxContext, ageDays: number): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `WITH a AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id),
          u AS (INSERT INTO public.users (id, is_synthetic, created_at)
                SELECT id, false, now() - make_interval(days => $1) FROM a RETURNING id)
     SELECT id FROM u`,
    [ageDays],
  );
  return rows[0].id;
}

// Create an ephemeral SYNTHETIC user (is_synthetic = true) — the State of Franklin
// seed shape. The detector must exclude these via author_excluded_from_standing.
async function createSyntheticUser(tx: TxContext): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `WITH a AS (INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id),
          u AS (INSERT INTO public.users (id, is_synthetic)
                SELECT id, true FROM a RETURNING id)
     SELECT id FROM u`,
  );
  return rows[0].id;
}

// Insert an entity_comment directly (controls all columns; entity_id is
// polymorphic with no FK, so a random uuid is a valid non-synthetic target).
async function insertComment(
  tx: TxContext,
  authorId: string,
  entityType: string,
  entityId: string,
  opts: { createdAt?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO public.entity_comments
       (id, entity_type, entity_id, author_id, kind, body, status, created_at)
     VALUES ($1,$2,$3,$4,'discussion',$5,'visible', COALESCE($6::timestamptz, now()))`,
    [id, entityType, entityId, authorId, VALID_BODY, opts.createdAt ?? null],
  );
  return id;
}

export const FIXTURES: Fixture[] = [
  // ───────────────────────── F1 — autotrip (HANDLED) ─────────────────────────
  {
    id: "F1",
    title: "Name-calling at an idea → 3 flags trip auto-collapse",
    ruleId: "entity_comments_flag_autotrip",
    expectation: "handled",
    expectedVerdict: "status visible→needs_review (never auto-hidden)",
    async run(tx) {
      const author = await tx.createUser("f1-author");
      const entityId = randomUUID();
      const commentId = await insertComment(tx, author, "proposal", entityId);
      // 3 distinct flaggers → trip the AFTER INSERT trigger on the 3rd.
      for (let i = 0; i < 3; i++) {
        const flagger = await tx.createUser(`f1-flagger-${i}`);
        await tx.query(
          `INSERT INTO public.content_flags
             (content_type, content_id, user_id, reason, resolved)
           VALUES ('entity_comment', $1, $2, 'harassment', false)`,
          [commentId, flagger],
        );
      }
      const [{ status }] = await tx.query<{ status: string }>(
        `SELECT status FROM public.entity_comments WHERE id = $1`,
        [commentId],
      );
      return {
        computedVerdict: `status=${status}`,
        match: status === "needs_review",
      };
    },
  },

  // ───────────── F2 — bridge scorer ranks steelman over insult (PARTIAL) ─────────────
  {
    id: "F2",
    title: "Ad hominem beside a steelman → steelman ranks above",
    ruleId: "recompute_comment_bridge_scores",
    expectation: "partial",
    expectedVerdict: "steelman bridge_score > insult bridge_score",
    async run(tx) {
      const author = await tx.createUser("f2-author");
      const entityType = "proposal";
      const entityId = randomUUID(); // non-synthetic, non-excluded
      const steelman = await insertComment(tx, author, entityType, entityId);
      const insult = await insertComment(tx, author, entityType, entityId);
      // 6 cross-stance raters: all find the steelman valuable (+1) from both
      // sides; the insult draws no cross-stance value (rated valuable=-1).
      for (let i = 0; i < 6; i++) {
        const rater = await tx.createUser(`f2-rater-${i}`);
        const stance = i % 2 === 0 ? 2 : -2;
        await tx.query(
          `INSERT INTO public.entity_positions (user_id, entity_type, entity_id, stance)
           VALUES ($1,$2,$3,$4)`,
          [rater, entityType, entityId, stance],
        );
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,1,$3)`,
          [steelman, rater, stance > 0 ? 1 : -1],
        );
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,-1,$3)`,
          [insult, rater, stance > 0 ? 1 : -1],
        );
      }
      await tx.query(`SELECT public.recompute_comment_bridge_scores($1,$2)`, [
        entityType,
        entityId,
      ]);
      const [{ s }] = await tx.query<{ s: number | null }>(
        `SELECT bridge_score AS s FROM public.entity_comments WHERE id = $1`,
        [steelman],
      );
      const [{ s: ins }] = await tx.query<{ s: number | null }>(
        `SELECT bridge_score AS s FROM public.entity_comments WHERE id = $1`,
        [insult],
      );
      const match = s != null && (ins == null || s > ins);
      return {
        computedVerdict: `steelman=${s} insult=${ins}`,
        match,
        notes:
          "Evaluable: cross-stance valuable→bridge_score ranks synthesis over the " +
          "uncited insult. The ad-hominem-detection semantic itself is not automated.",
      };
    },
  },

  // ───────────────── F3 — uncited claim rejected at write (HANDLED) ─────────────────
  {
    id: "F3",
    title: "Uncited conspiracy claim as evidence → card cannot be created",
    ruleId: "add_evidence_card (citation target must resolve)",
    expectation: "handled",
    expectedVerdict: "RAISE 42704 — citation target does not resolve",
    async run(tx) {
      const author = await tx.createUser("f3-author");
      const invId = randomUUID();
      await tx.query(
        `INSERT INTO public.investigations (id, title, created_by) VALUES ($1,$2,$3)`,
        [invId, "F3 harness investigation", author],
      );
      await tx.impersonate(author);
      // context card citing an internal_record 'official' that does not exist.
      const res = await tx.expectRaise(
        `SELECT public.add_evidence_card(
           $1, $2, 'context', NULL, NULL, NULL, NULL, NULL, false,
           'internal_record', 'official', $3, NULL)`,
        [invId, "secretly funds the opposition, no record cited at all", randomUUID()],
      );
      return {
        computedVerdict: res.raised ? `rejected (${res.code})` : "accepted",
        match: res.raised && res.code === "42704",
      };
    },
  },

  // ───────────────────── F4 — tier-3 citation rejected (HANDLED) ─────────────────────
  {
    id: "F4",
    title: "Tier-3 citation (external URL) → rejected at write",
    ruleId: "add_evidence_card (tier-1/2 only)",
    expectation: "handled",
    expectedVerdict: "RAISE 22023 — tier-3 citations not enabled yet",
    async run(tx) {
      const author = await tx.createUser("f4-author");
      const invId = randomUUID();
      await tx.query(
        `INSERT INTO public.investigations (id, title, created_by) VALUES ($1,$2,$3)`,
        [invId, "F4 harness investigation", author],
      );
      await tx.impersonate(author);
      const res = await tx.expectRaise(
        `SELECT public.add_evidence_card(
           $1, $2, 'context', NULL, NULL, NULL, NULL, NULL, false,
           'external_url', NULL, NULL, NULL)`,
        [invId, "here is a random external link as proof of the claim"],
      );
      return {
        computedVerdict: res.raised ? `rejected (${res.code})` : "accepted",
        match: res.raised && res.code === "22023",
      };
    },
  },

  // ─────────── F5 — defamation-shaped private-person claim held (PARTIAL) ───────────
  {
    id: "F5",
    title: "Defamation-shaped claim re a private person → held, not advanced",
    ruleId: "add_evidence_card subject_is_private_person + corroboration gate",
    expectation: "partial",
    expectedVerdict: "private-person flag recorded; single-source card stays 'proposed'",
    async run(tx) {
      const author = await tx.createUser("f5-author");
      const invId = randomUUID();
      await tx.query(
        `INSERT INTO public.investigations (id, title, created_by) VALUES ($1,$2,$3)`,
        [invId, "F5 harness investigation", author],
      );
      const cardId = randomUUID();
      await tx.query(
        `INSERT INTO public.evidence_cards
           (id, investigation_id, author_id, claim_text, claim_type,
            from_type, from_id, to_type, to_id, relationship_kind,
            subject_is_private_person, status)
         VALUES ($1,$2,$3,$4,'edge',
                 'financial_entity',$5,'official',$6,'donation', true,'proposed')`,
        [cardId, invId, author, "alleges wrongdoing by a private individual", randomUUID(), randomUUID()],
      );
      // single citation, single author → cannot reach the 2-independent threshold.
      await tx.query(
        `INSERT INTO public.citations (evidence_card_id, citation_type, target_type, target_id)
         VALUES ($1,'internal_record','vote',$2)`,
        [cardId, randomUUID()],
      );
      const [row] = await tx.query<{ pp: boolean; status: string }>(
        `SELECT subject_is_private_person AS pp, status FROM public.evidence_cards WHERE id=$1`,
        [cardId],
      );
      return {
        computedVerdict: `private_person=${row.pp} status=${row.status}`,
        match: row.pp === true && row.status === "proposed",
        notes:
          "Evaluable: the private-person flag persists and a single-source card does " +
          "NOT advance to 'corroborated'/display. The human review jury does not exist " +
          "yet — automated defamation detection is out of scope (manual admin path).",
      };
    },
  },

  // ─────────── F6 — bot burst / new-account halving on positions (PARTIAL) ───────────
  {
    id: "F6",
    title: "Bot burst → new-account-halved DB cap (Turnstile dormant)",
    ruleId: "set_entity_position (positions cap, new-account halving)",
    expectation: "partial",
    expectedVerdict: "RAISE 53400 at the halved (30) cap for a new account",
    async run(tx) {
      const author = await tx.createUser("f6-bot"); // created_at = now → new account
      // The cap counts position-change EVENTS (position_events), halved to 30 for
      // accounts < 24h old. Pre-seed exactly 30 events today → the 31st trips it.
      for (let i = 0; i < 30; i++) {
        await tx.query(
          `INSERT INTO public.position_events (user_id, entity_type, entity_id, to_stance)
           VALUES ($1,'proposal',$2,1)`,
          [author, randomUUID()],
        );
      }
      await tx.impersonate(author);
      const res = await tx.expectRaise(
        `SELECT public.set_entity_position('proposal',$1,1::smallint,NULL,NULL,NULL)`,
        [randomUUID()],
      );
      return {
        computedVerdict: res.raised ? `capped (${res.code})` : "uncapped",
        match: res.raised && res.code === "53400",
        notes:
          "Evaluable: the always-on DB cap (halved to 30 for accounts < 24h old) " +
          "blocks the burst. The Turnstile challenge layer is app-side and dormant " +
          "(no keys) — not evaluable in a DB harness.",
      };
    },
  },

  // ──────────────── F7 — per-user comment cap (HANDLED) ────────────────
  {
    id: "F7",
    title: "Rapid-fire low-quality volume → submit_comment 20/day cap",
    ruleId: "submit_comment (comments cap 20/day)",
    expectation: "handled",
    expectedVerdict: "RAISE 53400 — daily comment limit reached (20/day)",
    async run(tx) {
      const author = await tx.createUser("f7-spammer");
      const entityId = randomUUID();
      for (let i = 0; i < 20; i++) {
        await insertComment(tx, author, "proposal", entityId);
      }
      await tx.impersonate(author);
      const res = await tx.expectRaise(
        `SELECT public.submit_comment('proposal',$1,$2,'discussion',NULL,NULL,NULL)`,
        [randomUUID(), VALID_BODY],
      );
      return {
        computedVerdict: res.raised ? `capped (${res.code})` : "uncapped",
        match: res.raised && res.code === "53400",
      };
    },
  },

  // ──────────────── F8 — coordinated pile-on (HANDLED, SF-P4) ────────────────
  {
    id: "F8",
    title: "Coordinated pile-on: N accounts, same direction, tight timing",
    ruleId: "detect_brigade_candidates (fast)",
    expectation: "handled",
    expectedVerdict: "flags a coordinated cluster",
    async run(tx) {
      // 9 brand-new accounts rate one comment same-direction in a tight window —
      // the canonical fast pile-on. The SF-P4 detector should flag it.
      const author = await tx.createUser("f8-author");
      const entityId = randomUUID();
      const target = await insertComment(tx, author, "proposal", entityId);
      for (let i = 0; i < 9; i++) {
        const r = await tx.createUser(`f8-brig-${i}`);
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,1,1)`,
          [target, r],
        );
      }
      const hits = await tx.query<{ cluster_size: number; score: string }>(
        `SELECT cluster_size, score
           FROM public.detect_brigade_candidates('fast', ARRAY[$1]::uuid[])`,
        [target],
      );
      const hit = hits[0];
      return {
        computedVerdict: hit
          ? `flagged fast cluster (n=${hit.cluster_size}, score=${hit.score})`
          : "not_detected",
        match: Boolean(hit),
        notes: hit
          ? "SF-P4 fast detector flagged the coordinated pile-on. Detection only — no consequence."
          : "REGRESSION: SF-P4 fast detector did not flag 9 same-direction ratings in a tight window.",
      };
    },
  },

  // ──────────────── F9 — slow-burn brigade (HANDLED, SF-P4) ────────────────
  {
    id: "F9",
    title: "Slow-burn brigade: coordinated, under any per-window burst rate",
    ruleId: "detect_brigade_candidates (slow)",
    expectation: "handled",
    expectedVerdict: "flags low-and-slow cross-target coordination",
    async run(tx) {
      // 6 accounts co-rate the SAME direction across 4 targets, each target's
      // ratings spread >60 min apart — below any burst window, so the fast path
      // can't see it. Only cross-target co-occurrence reveals the coordination.
      const author = await tx.createUser("f9-author");
      const brig: string[] = [];
      for (let i = 0; i < 6; i++) brig.push(await tx.createUser(`f9-brig-${i}`));
      const targets: string[] = [];
      for (let j = 0; j < 4; j++) {
        const t = await insertComment(tx, author, "proposal", randomUUID());
        for (let k = 0; k < brig.length; k++) {
          // Spread within the target across days+minutes so no single 60-min
          // window holds the cluster (k*20 min ⇒ up to 100-min span).
          await tx.query(
            `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree, created_at)
             VALUES ($1,$2,1,1, now() - make_interval(days => $3, mins => $4))`,
            [t, brig[k], j + 1, k * 20],
          );
        }
        targets.push(t);
      }
      const hits = await tx.query<{ cluster_size: number; score: string }>(
        `SELECT cluster_size, score
           FROM public.detect_brigade_candidates('slow', $1::uuid[])`,
        [targets],
      );
      const hit = hits[0];
      return {
        computedVerdict: hit
          ? `flagged slow cluster (n=${hit.cluster_size}, score=${hit.score})`
          : "not_detected",
        match: Boolean(hit),
        notes: hit
          ? "SF-P4 slow detector flagged repeated cross-target co-occurrence below the burst window."
          : "REGRESSION: SF-P4 slow detector missed the cross-target co-occurrence cluster.",
      };
    },
  },

  // ──────── F8N — NEGATIVE: legitimate coordinated surge must NOT flag ────────
  {
    id: "F8N",
    title: "Organic surge by established accounts must NOT be flagged (FP guard)",
    ruleId: "detect_brigade_candidates (fast) — false-positive guard",
    expectation: "handled",
    expectedVerdict: "no brigade candidate (legitimate civic coordination)",
    async run(tx) {
      // The shape of a real signature drive / comment-period mobilization: a
      // same-day surge of same-direction ratings by ESTABLISHED accounts. The
      // established-account ratio is the FP guard — the detector must clear it.
      const author = await createAgedUser(tx, 500);
      const entityId = randomUUID();
      const target = await insertComment(tx, author, "proposal", entityId);
      for (let i = 0; i < 8; i++) {
        const r = await createAgedUser(tx, 400);
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,1,1)`,
          [target, r],
        );
      }
      const flagged =
        (
          await tx.query(
            `SELECT 1 FROM public.detect_brigade_candidates('fast', ARRAY[$1]::uuid[])`,
            [target],
          )
        ).length > 0;
      return {
        computedVerdict: flagged
          ? "FALSE POSITIVE: flagged an organic established-account surge"
          : "not_flagged (organic surge cleared)",
        match: !flagged,
        notes:
          "FP guard: established accounts in an organic surge must not read as a brigade. " +
          "No persisted verified-constituent flag exists (signal gap, cf FIX-571); account " +
          "age is the available discriminator.",
      };
    },
  },

  // ──────── F8S — synthetic seed (coordinated by design) must be excluded ─────
  {
    id: "F8S",
    title: "Synthetic seed pile-on (coordinated by design) must be excluded",
    ruleId: "detect_brigade_candidates — author_excluded_from_standing",
    expectation: "handled",
    expectedVerdict: "no brigade candidate (synthetic authors excluded)",
    async run(tx) {
      // Same shape as F8, but every rater is_synthetic — the State of Franklin
      // seed. The SF-P1 exclusion predicate must keep it out of the candidate set.
      const author = await createSyntheticUser(tx);
      const entityId = randomUUID();
      const target = await insertComment(tx, author, "proposal", entityId);
      for (let i = 0; i < 9; i++) {
        const r = await createSyntheticUser(tx);
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,1,1)`,
          [target, r],
        );
      }
      const flagged =
        (
          await tx.query(
            `SELECT 1 FROM public.detect_brigade_candidates('fast', ARRAY[$1]::uuid[])`,
            [target],
          )
        ).length > 0;
      return {
        computedVerdict: flagged
          ? "LEAK: synthetic cluster surfaced as a candidate"
          : "not_flagged (synthetic excluded)",
        match: !flagged,
        notes:
          "author_excluded_from_standing() keeps the State of Franklin seed (coordinated " +
          "by design) out of the candidate set even at a 9-account pile-on.",
      };
    },
  },

  // ──────────────── F10 — bridge gaming (GAP, with evidence) ────────────────
  {
    id: "F10",
    title: "Bridge-gaming: fake cross-bloc agreement farms bridge_score",
    ruleId: "recompute_comment_bridge_scores (no anti-gaming)",
    expectation: "gap",
    expectedVerdict: "scorer should resist farming (low / no score)",
    async run(tx) {
      const author = await tx.createUser("f10-author");
      const entityType = "proposal";
      const entityId = randomUUID();
      const gamed = await insertComment(tx, author, entityType, entityId);
      // Coordinated raters fake a perfectly balanced cross-bloc endorsement.
      for (let i = 0; i < 6; i++) {
        const r = await tx.createUser(`f10-puppet-${i}`);
        const stance = i % 2 === 0 ? 2 : -2;
        await tx.query(
          `INSERT INTO public.entity_positions (user_id, entity_type, entity_id, stance)
           VALUES ($1,$2,$3,$4)`,
          [r, entityType, entityId, stance],
        );
        await tx.query(
          `INSERT INTO public.comment_ratings (comment_id, rater_id, valuable, agree)
           VALUES ($1,$2,1,$3)`,
          [gamed, r, stance > 0 ? 1 : -1],
        );
      }
      await tx.query(`SELECT public.recompute_comment_bridge_scores($1,$2)`, [
        entityType,
        entityId,
      ]);
      const [{ s }] = await tx.query<{ s: number | null }>(
        `SELECT bridge_score AS s FROM public.entity_comments WHERE id = $1`,
        [gamed],
      );
      // "Resisted" would mean a low/null score. A balanced fake cross-vote farms
      // a high score → not resisted → MISMATCH (known-failing).
      const resisted = s == null || Number(s) < 0.5;
      return {
        computedVerdict: `farmed bridge_score=${s}`,
        match: resisted,
        notes:
          "GAP (SF-P5): bridge_score is farmable via coordinated balanced cross-bloc " +
          `valuable=+1 votes. Achieved score=${s} with zero genuine disagreement. ` +
          "No anti-gaming layer. Permanent MISMATCH until the scorer is hardened.",
      };
    },
  },

  // ──────────────── F11 — sockpuppet corroboration (PARTIAL) ────────────────
  {
    id: "F11",
    title: "Sockpuppet self-corroboration → independence lock holds",
    ruleId: "count_independent_corroborations (dedup by author AND target)",
    expectation: "partial",
    expectedVerdict: "same-author cards count as 1 → card stays 'proposed'",
    async run(tx) {
      const author = await tx.createUser("f11-puppeteer");
      const invId = randomUUID();
      await tx.query(
        `INSERT INTO public.investigations (id, title, created_by) VALUES ($1,$2,$3)`,
        [invId, "F11 harness investigation", author],
      );
      const fromId = randomUUID();
      const toId = randomUUID();
      // Two edge cards on the SAME edge, SAME author (the sockpuppet), with
      // DISTINCT citation targets — distinct-target leg passes, author leg = 1.
      const cardIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const cardId = randomUUID();
        await tx.query(
          `INSERT INTO public.evidence_cards
             (id, investigation_id, author_id, claim_text, claim_type,
              from_type, from_id, to_type, to_id, relationship_kind, status)
           VALUES ($1,$2,$3,$4,'edge','financial_entity',$5,'official',$6,'donation','proposed')`,
          [cardId, invId, author, `edge claim variant ${i} for the same relationship`, fromId, toId],
        );
        await tx.query(
          `INSERT INTO public.citations (evidence_card_id, citation_type, target_type, target_id)
           VALUES ($1,'internal_record','vote',$2)`,
          [cardId, randomUUID()],
        );
        cardIds.push(cardId);
      }
      const [{ n }] = await tx.query<{ n: number }>(
        `SELECT public.count_independent_corroborations($1) AS n`,
        [cardIds[0]],
      );
      const [{ status }] = await tx.query<{ status: string }>(
        `SELECT status FROM public.evidence_cards WHERE id = $1`,
        [cardIds[0]],
      );
      return {
        computedVerdict: `independent=${n} status=${status}`,
        match: Number(n) < 2 && status === "proposed",
        notes:
          "Evaluable: the author-dedup leg rejects same-account self-corroboration " +
          "(LEAST(authors=1, targets=2)=1 < 2). Multi-account sockpuppets sharing one " +
          "human identity are not detectable here — that's SF-P6 (identity).",
      };
    },
  },

  // ──────────────── F12 — sealioning (GAP) ────────────────
  {
    id: "F12",
    title: "Sealioning / concern-trolling: endless civil 'just asking questions'",
    ruleId: "— (no automated signal by design)",
    expectation: "gap",
    expectedVerdict: "should surface persistent bad-faith questioning",
    async run(tx) {
      const exists = await detectorExists(tx, "sealion", "concern_troll", "bad_faith");
      return {
        computedVerdict: exists ? "detector present" : "not_detected",
        match: false,
        notes:
          "GAP (SF-P10): sealioning slips past automation by design. Requires an " +
          "explicit policy decision — manual/community-signal only, or a documented " +
          "won't-fix. Permanent MISMATCH until that decision is recorded.",
      };
    },
  },
];
