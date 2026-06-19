/**
 * data:seed:franklin — idempotent seed of the State of Franklin S1 (Ridgeline)
 * demonstration slice (FIX-607).
 *
 * The FIRST synthetic content on the platform: every entity row carries
 * is_synthetic=true and every author is a synthetic user, so this run is also
 * the first real exercise of the FIX-572 quarantine, SF-P2 labeling, FIX-600
 * platform-total exclusion, and FIX-601 moderation harness on actual data.
 *
 *   pnpm --filter @civitics/data data:seed:franklin
 *   pnpm --filter @civitics/data data:seed:franklin -- --db-url postgresql://...
 *   pnpm --filter @civitics/data data:seed:franklin -- --allow-prod   (gated)
 *
 * Defaults to LOCAL Docker. A prod run writes synthetic rows to production and
 * requires --allow-prod AND a supabase.co --db-url. Insert order follows
 * state-of-franklin-bible §13.1 (dependencies first).
 */

import { Client } from "pg";
import {
  LOCAL_DB_URL,
  MONEY_DATE,
  SeedCtx,
  VOTE_DATE,
  grantStaff,
  jb,
  loadJson,
  splitName,
  upsertById,
  upsertUser,
} from "./lib";

/* eslint-disable no-console */

// ---------------------------------------------------------------------------
// Logical-file shapes (only the fields we read).
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;
interface Entities {
  jurisdictions: Array<Json & { seed_key: string; name: string; level: string; parent: string | null; abbr?: string; notes?: string }>;
  governing_bodies: Array<Json & { seed_key: string; name: string; type: string; jurisdiction: string; notes?: string }>;
  agencies: Array<Json & { seed_key: string; name: string; acronym: string; jurisdiction: string; role?: string }>;
  officials: Array<
    Json & {
      seed_key: string;
      full_name: string;
      role: string;
      jurisdiction: string;
      governing_body: string | null;
      district: string | null;
      bloc: string;
      is_passive: boolean;
    }
  >;
}
interface MoneyGraph {
  financial_entities: Array<Json & { seed_key: string; display_name: string; kind: string; officer?: string; note?: string }>;
  financial_relationships: Array<
    Json & { seed_key: string; from: string; to: string; kind: string; amount_usd: number | null; confidence: string; feeds: string | null; note?: string }
  >;
}
interface Proposals {
  proposals: Array<
    Json & {
      seed_key: string;
      bill_number: string;
      title: string;
      type: string;
      status: string;
      comment_window: string;
      sponsor: string;
      cosponsors: string[];
      summary_plain: string;
      sections?: string[];
      outcome?: string;
      votes: Array<{ official: string; vote: string; note?: string }>;
      vote_question: string;
      chamber: string;
    }
  >;
}
interface Citizens {
  citizens: Array<Json & { seed_key: string; handle: string }>;
}
interface Positions {
  positions: Array<Json & { seed_key: string; author: string; proposal: string; stance: string; statement: string }>;
}
interface Threads {
  comments: Array<
    Json & {
      seed_key: string;
      author: string;
      parent: string | null;
      kind: string;
      body: string;
      bridge_score: number | null;
      map_x?: number;
      map_y?: number;
      is_bridge_moment?: string;
      authored_raters?: Json;
      note?: string;
    }
  >;
}
interface Investigations {
  investigations: Array<
    Json & {
      seed_key: string;
      title: string;
      question: string;
      scope_entity: string;
      scope_jurisdiction: string;
      created_by: string;
      status: string;
      findings: string;
      evidence_cards: Array<
        Json & {
          seed_key: string;
          claim_type: string;
          claim: string;
          from?: string;
          to?: string;
          relationship_kind?: string;
          cites: string[];
          status: string;
        }
      >;
    }
  >;
}
interface Initiatives {
  initiatives: Array<
    Json & {
      seed_key: string;
      title: string;
      authorship_type: string;
      scope: string;
      stage: string;
      linked_proposal: string;
      resolution_type: string;
      primary_author: string;
      summary: string;
      signatures: Array<{ user: string; verification_tier: string; district?: string }>;
      responses: Array<{ official: string; response_type: string; body: string }>;
    }
  >;
}
interface Fixtures {
  fixture_authors: Array<Json & { seed_key: string; handle: string }>;
  fixtures: Array<
    Json & { seed_key: string; author: string; entity_type: string; entity_id: string; kind: string; body: string; authored_status: string; authored_flags: number }
  >;
}

// ---------------------------------------------------------------------------
// Mapping helpers (logical -> physical).
// ---------------------------------------------------------------------------
const JURIS_TYPE: Record<string, string> = { state: "state", city: "city" };
const GB_TYPE: Record<string, string> = {
  legislature_unicameral: "legislature_unicameral",
  city_council: "municipal_council",
};
function partyForBloc(bloc: string): string {
  return bloc === "independent" ? "independent" : "other";
}
function feKind(kind: string): string {
  return kind === "pac" ? "pac" : "other";
}
function stanceToSmallint(stance: string): number {
  if (stance === "support") return 2;
  if (stance === "oppose") return -2;
  return 0; // mixed
}
// edge-card relationship kinds in the logical money graph ("funds",
// "contributes_to") are all donation-shaped money flow; the assertable graph
// enum names that 'donation'.
const EDGE_KIND = "donation";

function isProdUrl(url: string): boolean {
  return /supabase\.(co|com)/i.test(url);
}
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

interface Args {
  dbUrl: string;
  allowProd: boolean;
  refreshAllMvs: boolean;
}
function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl = process.env.SUPABASE_DB_URL ?? LOCAL_DB_URL;
  let allowProd = false;
  let refreshAllMvs = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--refresh-all-mvs") refreshAllMvs = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: data:seed:franklin [--db-url <url>] [--allow-prod] [--refresh-all-mvs]");
      process.exit(0);
    }
  }
  return { dbUrl, allowProd, refreshAllMvs };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function seedEntities(ctx: SeedCtx, e: Entities): Promise<void> {
  for (const j of e.jurisdictions) {
    const parentId = j.parent ? ctx.id(j.parent) : null;
    await upsertById(
      ctx,
      j.seed_key,
      "jurisdictions",
      {
        type: JURIS_TYPE[j.level] ?? "other",
        name: j.name,
        short_name: j.abbr ?? null,
        parent_id: parentId,
        is_synthetic: true,
        metadata: jb({ seed_key: j.seed_key, demonstration: true, notes: j.notes ?? null }),
      },
      new Set(["metadata"]),
    );
  }
  for (const gb of e.governing_bodies) {
    await upsertById(
      ctx,
      gb.seed_key,
      "governing_bodies",
      {
        jurisdiction_id: ctx.id(gb.jurisdiction),
        type: GB_TYPE[gb.type] ?? "other",
        name: gb.name,
        is_synthetic: true,
        metadata: jb({ seed_key: gb.seed_key, notes: gb.notes ?? null }),
      },
      new Set(["metadata"]),
    );
  }
  for (const a of e.agencies) {
    const j = e.jurisdictions.find((x) => x.seed_key === a.jurisdiction);
    // agencies.acronym is GLOBALLY unique; real agencies may already own it
    // (e.g. federal "WCPO"). S1 agencies are unexercised graph nodes, so on a
    // collision with a non-Franklin row we null the column and keep the intended
    // acronym in metadata. Exclude our own row so re-runs don't self-null.
    const ownId = ctx.maybeId(a.seed_key);
    const clash = await ctx.query<{ id: string }>(
      `SELECT id FROM public.agencies WHERE acronym = $1 AND ($2::uuid IS NULL OR id <> $2)`,
      [a.acronym, ownId],
    );
    const acronymCol = clash.length > 0 ? null : a.acronym;
    await upsertById(
      ctx,
      a.seed_key,
      "agencies",
      {
        jurisdiction_id: ctx.id(a.jurisdiction),
        name: a.name,
        acronym: acronymCol,
        agency_type: j?.level === "city" ? "local" : "state",
        description: a.role ?? null,
        is_synthetic: true,
        metadata: jb({ seed_key: a.seed_key, acronym: a.acronym }),
      },
      new Set(["metadata"]),
    );
  }
  for (const o of e.officials) {
    const { first, last } = splitName(o.full_name);
    const tier = o.role.toLowerCase().includes("former") ? "former" : "elected";
    await upsertById(
      ctx,
      o.seed_key,
      "officials",
      {
        governing_body_id: o.governing_body ? ctx.id(o.governing_body) : null,
        jurisdiction_id: ctx.id(o.jurisdiction),
        full_name: o.full_name,
        first_name: first,
        last_name: last,
        role_title: o.role,
        party: partyForBloc(o.bloc),
        district_name: o.district,
        tier,
        is_active: tier !== "former",
        is_synthetic: true,
        metadata: jb({
          seed_key: o.seed_key,
          bloc: o.bloc,
          is_passive: o.is_passive,
          top_issues: o.top_issues ?? [],
          funding_note: o.funding_note ?? null,
          signature_item: o.signature_item ?? null,
          ridgeline_vote: o.ridgeline_vote ?? null,
          tension: o.tension ?? null,
          bio: o.bio ?? null,
          passive_note: o.passive_note ?? null,
        }),
      },
      new Set(["metadata"]),
    );
  }
}

async function seedMoney(ctx: SeedCtx, m: MoneyGraph): Promise<void> {
  for (const fe of m.financial_entities) {
    await upsertById(
      ctx,
      fe.seed_key,
      "financial_entities",
      {
        canonical_name: fe.display_name,
        display_name: fe.display_name,
        entity_type: feKind(fe.kind),
        is_synthetic: true,
        metadata: jb({ seed_key: fe.seed_key, officer: fe.officer ?? null, note: fe.note ?? null }),
      },
      new Set(["metadata"]),
    );
  }
  for (const fr of m.financial_relationships) {
    const fromIsFe = fr.from.startsWith("pac-") || fr.from.startsWith("donor-");
    const toIsFe = fr.to.startsWith("pac-") || fr.to.startsWith("donor-");
    const fromType = fromIsFe ? "financial_entity" : "official";
    const toType = toIsFe ? "financial_entity" : "official";
    const isContribution = fr.kind === "contribution";
    await upsertById(
      ctx,
      fr.seed_key,
      "financial_relationships",
      {
        relationship_type: isContribution ? "donation" : "other",
        from_type: fromType,
        from_id: ctx.id(fr.from),
        to_type: toType,
        to_id: ctx.id(fr.to),
        amount_cents: fr.amount_usd == null ? null : fr.amount_usd * 100,
        // CHECK: contributions are point-in-time (occurred_at); the ongoing board
        // affiliation uses started_at.
        occurred_at: isContribution ? MONEY_DATE : null,
        started_at: isContribution ? null : MONEY_DATE,
        cycle_year: 2026,
        metadata: jb({ seed_key: fr.seed_key, confidence: fr.confidence, feeds: fr.feeds, note: fr.note ?? null }),
      },
      new Set(["metadata"]),
    );
  }
}

async function seedProposalsAndVotes(ctx: SeedCtx, p: Proposals, franklinJuris: string, assemblyGb: string): Promise<void> {
  for (const prop of p.proposals) {
    const status = prop.status === "open_comment" ? "open_comment" : "failed";
    const propId = await upsertById(
      ctx,
      prop.seed_key,
      "proposals",
      {
        type: "bill",
        status,
        jurisdiction_id: franklinJuris,
        governing_body_id: assemblyGb,
        title: prop.title,
        summary_plain: prop.summary_plain,
        introduced_at: "2026-02-01",
        last_action_at: VOTE_DATE.slice(0, 10),
        is_synthetic: true,
        metadata: jb({
          seed_key: prop.seed_key,
          bill_number: prop.bill_number,
          sections: prop.sections ?? [],
          outcome: prop.outcome ?? null,
          sponsor: prop.sponsor,
          cosponsors: prop.cosponsors ?? [],
          comment_window: prop.comment_window,
          // open comment windows surface as "open"; future end keeps it live.
          comment_period_end: prop.comment_window === "open" ? "2026-12-31" : "2026-04-10",
        }),
      },
      new Set(["metadata"]),
    );

    // bill_details (votes FK -> bill_details.proposal_id). PK is proposal_id.
    await ctx.query(
      `INSERT INTO public.bill_details (proposal_id, bill_number, chamber, session, jurisdiction_id, primary_sponsor_id)
       VALUES ($1, $2, $3, '2026', $4, $5)
       ON CONFLICT (proposal_id) DO UPDATE
         SET bill_number = EXCLUDED.bill_number, chamber = EXCLUDED.chamber,
             primary_sponsor_id = EXCLUDED.primary_sponsor_id`,
      [propId, prop.bill_number, prop.chamber, franklinJuris, ctx.id(prop.sponsor)],
    );
    await ctx.record(`${prop.seed_key}:bill_details`, "bill_details", propId);

    const rollCallId = `franklin-${prop.seed_key}-passage`;
    for (const v of prop.votes) {
      const voteKey = `${prop.seed_key}:vote:${v.official}`;
      await upsertById(
        ctx,
        voteKey,
        "votes",
        {
          bill_proposal_id: propId,
          official_id: ctx.id(v.official),
          vote: v.vote,
          voted_at: VOTE_DATE,
          roll_call_id: rollCallId,
          vote_question: prop.vote_question,
          chamber: prop.chamber,
          session: "2026",
          metadata: jb({ seed_key: voteKey, note: v.note ?? null }),
        },
        new Set(["metadata"]),
      );
    }
  }
}

async function seedCitizens(ctx: SeedCtx, c: Citizens): Promise<void> {
  for (const cz of c.citizens) {
    const { seed_key, handle, ...persona } = cz;
    await upsertUser(ctx, seed_key, handle, persona);
  }
}

async function seedPositions(ctx: SeedCtx, pos: Positions): Promise<void> {
  for (const p of pos.positions) {
    if (p.author.startsWith("off-")) {
      // Officials aren't users; their stance on a bill IS their vote. Attach the
      // authored rationale to the vote's metadata (travels + resets with it).
      const voteKey = `${p.proposal}:vote:${p.author}`;
      if (ctx.has(voteKey)) {
        await ctx.query(
          `UPDATE public.votes SET metadata = metadata || $2::jsonb WHERE id = $1`,
          [ctx.id(voteKey), jb({ statement: p.statement, stance: p.stance })],
        );
      }
      continue;
    }
    // Citizen positions: entity_positions, keyed by (user, entity). No uuid id, so
    // not tracked in the seed_map — reset deletes by synthetic author.
    await ctx.query(
      `INSERT INTO public.entity_positions (user_id, entity_type, entity_id, stance, conditions_md)
       VALUES ($1, 'proposal', $2, $3, $4)
       ON CONFLICT (user_id, entity_type, entity_id)
         DO UPDATE SET stance = EXCLUDED.stance, conditions_md = EXCLUDED.conditions_md`,
      [ctx.id(p.author), ctx.id(p.proposal), stanceToSmallint(p.stance), p.statement],
    );
  }
}

async function seedThread(ctx: SeedCtx, t: Threads, hb14: string): Promise<void> {
  for (const c of t.comments) {
    const parentId = c.parent ? ctx.id(c.parent) : null;
    // thread_root_id: roots are null at insert; replies inherit the root.
    let threadRoot: string | null = null;
    if (parentId) {
      const r = await ctx.query<{ thread_root_id: string | null }>(
        `SELECT thread_root_id FROM public.entity_comments WHERE id = $1`,
        [parentId],
      );
      threadRoot = r[0]?.thread_root_id ?? parentId;
    }
    await upsertById(
      ctx,
      c.seed_key,
      "entity_comments",
      {
        entity_type: "proposal",
        entity_id: hb14,
        parent_id: parentId,
        thread_root_id: threadRoot,
        author_id: ctx.id(c.author),
        kind: "discussion",
        body: c.body,
        status: "visible",
        bridge_score: c.bridge_score,
        map_x: c.map_x ?? null,
        map_y: c.map_y ?? null,
        rating_summary: jb(c.authored_raters ?? {}),
        metadata: jb({ seed_key: c.seed_key, is_bridge_moment: c.is_bridge_moment ?? null, note: c.note ?? null }),
      },
      new Set(["rating_summary", "metadata"]),
    );
  }
}

async function seedFixtures(ctx: SeedCtx, f: Fixtures): Promise<void> {
  for (const fa of f.fixture_authors) {
    const { seed_key, handle, ...rest } = fa;
    await upsertUser(ctx, seed_key, handle, rest);
  }
  // Three stable citizen flaggers exercise the real ≥3-flag autotrip floor.
  const flaggers = ["cit-clerkemeritus", "cit-ridgelinerose", "cit-oldgrowthowen"];
  const reasonFor = (caseId: string): string => (String(caseId).startsWith("F1") ? "harassment" : "spam");
  for (const fx of f.fixtures) {
    const entityId = ctx.id(fx.entity_id);
    const commentId = await upsertById(
      ctx,
      fx.seed_key,
      "entity_comments",
      {
        entity_type: "proposal",
        entity_id: entityId,
        parent_id: null,
        thread_root_id: null,
        author_id: ctx.id(fx.author),
        kind: "discussion",
        body: fx.body,
        status: fx.authored_status, // needs_review (also reached via the flags below)
        metadata: jb({ seed_key: fx.seed_key, casebook_id: fx.casebook_id ?? null, is_fixture: true }),
      },
      new Set(["metadata"]),
    );
    const reason = reasonFor(String(fx.casebook_id ?? ""));
    for (let i = 0; i < Math.min(3, flaggers.length); i++) {
      await ctx.query(
        `INSERT INTO public.content_flags (content_type, content_id, user_id, reason)
         VALUES ('entity_comment', $1, $2, $3)
         ON CONFLICT (content_type, content_id, user_id) DO NOTHING`,
        [commentId, ctx.id(flaggers[i]), reason],
      );
    }
  }
}

async function seedInitiative(ctx: SeedCtx, init: Initiatives): Promise<void> {
  for (const it of init.initiatives) {
    const propId = await upsertById(
      ctx,
      it.seed_key,
      "proposals",
      {
        type: "initiative",
        status: "introduced",
        jurisdiction_id: ctx.id("juris-franklin"),
        title: it.title,
        summary_plain: it.summary,
        is_synthetic: true,
        metadata: jb({ seed_key: it.seed_key, scope: it.scope, linked_proposal: it.linked_proposal }),
      },
      new Set(["metadata"]),
    );
    await ctx.query(
      `INSERT INTO public.initiative_details
         (proposal_id, stage, authorship_type, primary_author_id, scope, body_md, resolution_type, signature_threshold, issue_area_tags, mobilise_started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (proposal_id) DO UPDATE SET
         stage = EXCLUDED.stage, authorship_type = EXCLUDED.authorship_type,
         primary_author_id = EXCLUDED.primary_author_id, scope = EXCLUDED.scope,
         body_md = EXCLUDED.body_md, resolution_type = EXCLUDED.resolution_type,
         signature_threshold = EXCLUDED.signature_threshold, issue_area_tags = EXCLUDED.issue_area_tags`,
      [
        propId,
        it.stage,
        it.authorship_type,
        ctx.id(it.primary_author),
        it.scope,
        it.summary,
        it.resolution_type,
        25,
        ["energy", "just-transition"],
        "2026-03-15",
      ],
    );
    await ctx.record(`${it.seed_key}:details`, "initiative_details", propId);

    for (const sig of it.signatures) {
      await ctx.query(
        `INSERT INTO public.civic_initiative_signatures (initiative_id, user_id, verification_tier, district)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (initiative_id, user_id)
           DO UPDATE SET verification_tier = EXCLUDED.verification_tier, district = EXCLUDED.district`,
        [propId, ctx.id(sig.user), sig.verification_tier, sig.district ?? null],
      );
    }
    for (const resp of it.responses) {
      // official_response_type has no 'sponsored'; the sponsored-into-Title-IV
      // action maps to 'support'.
      await ctx.query(
        `INSERT INTO public.civic_initiative_responses (initiative_id, official_id, response_type, body_text, responded_at)
         VALUES ($1, $2, 'support', $3, $4)
         ON CONFLICT (initiative_id, official_id)
           DO UPDATE SET response_type = EXCLUDED.response_type, body_text = EXCLUDED.body_text, responded_at = EXCLUDED.responded_at`,
        [propId, ctx.id(resp.official), resp.body, "2026-04-20T12:00:00Z"],
      );
    }
  }
}

async function seedInvestigation(ctx: SeedCtx, inv: Investigations): Promise<void> {
  for (const investigation of inv.investigations) {
    const authorId = ctx.id(investigation.created_by);
    await grantStaff(ctx, authorId);

    // Create the investigation once (RPC attributes created_by = auth.uid()).
    let invId = ctx.maybeId(investigation.seed_key);
    if (!invId) {
      invId = await ctx.withAuthor(authorId, async () => {
        const row = await ctx.one<{ id: string }>(
          `SELECT (public.create_investigation($1, $2, 'proposal', $3, NULL)).id AS id`,
          [investigation.title, investigation.question, ctx.id(investigation.scope_entity)],
        );
        return row.id;
      });
      await ctx.record(investigation.seed_key, "investigations", invId);
    }
    // Findings + synthetic / seeded / featured flags (direct; seed privilege).
    await ctx.withAuthor(authorId, async () => {
      await ctx.query(`SELECT public.set_investigation_findings($1, $2, 'open')`, [invId, investigation.findings]);
    });
    await ctx.query(
      `UPDATE public.investigations SET is_synthetic = true, is_seeded = true, is_featured = true WHERE id = $1`,
      [invId],
    );

    for (const card of investigation.evidence_cards) {
      if (ctx.has(card.seed_key)) continue; // create-once
      const targets = card.cites.map((c) => resolveCitation(ctx, c)).filter((t): t is CiteTarget => t !== null);
      if (targets.length === 0) throw new Error(`evidence card ${card.seed_key} has no resolvable citation`);
      const isEdge = card.claim_type === "edge";
      const cardId = await ctx.withAuthor(authorId, async () => {
        const row = await ctx.one<{ id: string }>(
          `SELECT (public.add_evidence_card($1,$2,$3,$4,$5,$6,$7,$8,false,'internal_record',$9,$10,$11)).id AS id`,
          [
            invId,
            card.claim,
            card.claim_type,
            isEdge ? "financial_entity" : null,
            isEdge && card.from ? ctx.id(card.from) : null,
            isEdge ? edgeToType(card.to!) : null,
            isEdge && card.to ? ctx.id(card.to) : null,
            isEdge ? EDGE_KIND : null,
            targets[0].type,
            targets[0].id,
            null,
          ],
        );
        // additional citations
        for (const t of targets.slice(1)) {
          await ctx.query(`SELECT public.add_citation($1, 'internal_record', $2, $3, NULL)`, [row.id, t.type, t.id]);
        }
        return row.id;
      });
      await ctx.record(card.seed_key, "evidence_cards", cardId);
      await ctx.query(`UPDATE public.evidence_cards SET is_synthetic = true WHERE id = $1`, [cardId]);

      // Authored end-state status (bible §9.3 precedent: seed sets display state).
      if (isEdge && card.status === "promoted") {
        await ctx.query(`UPDATE public.evidence_cards SET status = 'corroborated' WHERE id = $1`, [cardId]);
        await ctx.query(`SELECT public.promote_evidence_edge($1, $2)`, [cardId, authorId]);
      } else if (card.status === "corroborated") {
        await ctx.query(`UPDATE public.evidence_cards SET status = 'corroborated' WHERE id = $1`, [cardId]);
      }
      // 'proposed' (e.g. ec-06, single inferred source) is left untouched —
      // the system would refuse to promote it. That is the demonstration.
    }
  }
}

interface CiteTarget {
  type: string;
  id: string;
}
function edgeToType(toSeed: string): string {
  return toSeed.startsWith("pac-") || toSeed.startsWith("donor-") ? "financial_entity" : "official";
}
/** Resolve a logical citation pointer to a (target_type, target_id) the RPC accepts. */
function resolveCitation(ctx: SeedCtx, pointer: string): CiteTarget | null {
  if (pointer.startsWith("fr-")) return { type: "financial_relationship", id: ctx.id(pointer) };
  if (pointer.includes(":vote:")) return { type: "vote", id: ctx.id(pointer) };
  if (pointer.startsWith("off-")) return { type: "official", id: ctx.id(pointer) };
  if (pointer.startsWith("pac-") || pointer.startsWith("donor-")) return { type: "financial_entity", id: ctx.id(pointer) };
  if (pointer.startsWith("prop-")) return { type: "proposal", id: ctx.id(pointer) };
  // entity_position pointers (pos-*) are not a citable internal_record target;
  // skip — ec-07 keeps the vote + official citations that carry the meaning.
  if (pointer.startsWith("pos-")) return null;
  return null;
}

async function refreshMvs(ctx: SeedCtx, all: boolean): Promise<void> {
  // commons_active_threads is the only MV that surfaces synthetic content (the
  // HB-14 thread, Option-2 include+label). Every other MV here is a platform-
  // wide aggregate that EXCLUDES synthetic (FIX-600), so refreshing it after a
  // synthetic-only seed is a no-op — and on prod they scan millions of rows and
  // can saturate Pro I/O. Default to the one that matters; --refresh-all-mvs
  // opts into the full set (local convenience only).
  const fns = all
    ? [
        "refresh_commons_active_threads_mv",
        "refresh_homepage_stats_mv",
        "refresh_homepage_agency_counts_mv",
        "refresh_official_homepage_stats_mv",
        "refresh_entity_connection_stats_mv",
        "refresh_official_donor_rollup_mv",
        "refresh_official_sector_dollars_mv",
        "refresh_donor_party_rollup_mv",
      ]
    : ["refresh_commons_active_threads_mv"];
  for (const fn of fns) {
    try {
      await ctx.query(`SELECT public.${fn}()`);
      console.log(`  refreshed ${fn}`);
    } catch (err) {
      console.log(`  (skipped ${fn}: ${(err as Error).message})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { dbUrl, allowProd, refreshAllMvs } = parseArgs(process.argv);
  const h = host(dbUrl);
  const prod = isProdUrl(dbUrl);
  if (prod && !allowProd) {
    console.error(
      `REFUSING to seed what looks like prod (${h}) without --allow-prod.\n` +
        "Seeding writes synthetic Franklin rows to the target DB. Prod seeding is a\n" +
        "separate, explicitly-confirmed step (see the FIX-607 prompt). Re-run with\n" +
        "--allow-prod only after that go-ahead.",
    );
    process.exit(2);
  }

  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`data:seed:franklin — host=${h} ${prod ? "(PROD)" : "(local)"}`);

  const ctx = new SeedCtx(client);
  try {
    await ctx.loadMap();

    const entities = loadJson<Entities>("entities.json");
    const money = loadJson<MoneyGraph>("money-graph.json");
    const proposals = loadJson<Proposals>("proposals.json");
    const citizens = loadJson<Citizens>("citizens.json");
    const positions = loadJson<Positions>("positions.json");
    const threads = loadJson<Threads>("threads.json");
    const investigations = loadJson<Investigations>("investigations.json");
    const initiatives = loadJson<Initiatives>("initiatives.json");
    const fixtures = loadJson<Fixtures>("fixtures.json");

    console.log("1-4  entities (jurisdictions, bodies, agencies, officials)…");
    await seedEntities(ctx, entities);
    console.log("5-6  money graph (entities + relationships)…");
    await seedMoney(ctx, money);
    console.log("7-8  proposals + bill_details + votes…");
    await seedProposalsAndVotes(ctx, proposals, ctx.id("juris-franklin"), ctx.id("gb-assembly"));
    console.log("10   citizen + curator + fixture-author users…");
    await upsertUser(ctx, "user-curator", "Franklin Commons", { role: "curator", is_curator: true });
    await seedCitizens(ctx, citizens);
    console.log("9    initiative (proposal + details + signatures + responses)…");
    await seedInitiative(ctx, initiatives);
    console.log("11   positions…");
    await seedPositions(ctx, positions);
    console.log("12   HB-14 thread (curator opener, roots, replies, B-1 bridge)…");
    await seedThread(ctx, threads, ctx.id("prop-hb14"));
    console.log("13   moderation fixtures + content_flags (≥3 → needs_review)…");
    await seedFixtures(ctx, fixtures);
    console.log("14   Investigation #1 (evidence cards + citations + promotion)…");
    await seedInvestigation(ctx, investigations);
    console.log("16   refresh materialized views…");
    await refreshMvs(ctx, refreshAllMvs);

    const counts = await ctx.one<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM public.officials WHERE is_synthetic) AS officials,
         (SELECT count(*) FROM public.financial_relationships fr
            JOIN public.synthetic_entities se ON (se.entity_type='financial_entity' AND se.entity_id=fr.from_id)
                                              OR (se.entity_type='official' AND se.entity_id=fr.from_id)) AS money_edges,
         (SELECT count(*) FROM public.votes v JOIN public.proposals p ON p.id=v.bill_proposal_id WHERE p.is_synthetic) AS votes,
         (SELECT count(*) FROM public.entity_comments WHERE author_id IN (SELECT id FROM public.users WHERE is_synthetic)) AS comments,
         (SELECT count(*) FROM public.evidence_cards WHERE is_synthetic) AS cards,
         (SELECT count(*) FROM public.evidence_cards WHERE is_synthetic AND status='promoted') AS promoted_cards,
         (SELECT count(*) FROM public.franklin_seed_map) AS mapped`,
    );
    console.log("\nDone. Synthetic counts:", counts);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
