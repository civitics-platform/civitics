/**
 * data:seed:franklin — idempotent seed of the State of Franklin demonstration
 * place: S1 (Ridgeline) + S2 (broadband / water / STR + stadium + breadth).
 * FIX-607 (S1) extended for S2.
 *
 * S2 is ADDITIVE: it references S1 entities by seed_key and only extends the
 * proposals / positions / threads / investigations / initiatives slices. The
 * loader ingests S1 then S2 in one merged pass, keyed on seed_key via
 * franklin_seed_map, so re-runs stay idempotent. s2/qa.json (agency Q&A) is
 * DEFERRED until an agency Q&A surface exists (FIX-610).
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_KINDS, DEFAULT_KIND, type EntityCommentType } from "@civitics/db";
import { Client } from "pg";
import {
  LOCAL_DB_URL,
  MONEY_DATE,
  SEED_EPOCH,
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
      // S1: 'open_comment' | 'closed'. S2 adds council 'measure' rows; the
      // physical proposal_type is always 'bill' so the proposal page's
      // type==='bill'-gated vote + bill_details section renders for measures too.
      status: string;
      comment_window: string;
      // S2 CM-24 is sponsored by an agency (ag-watauga-planning); only off-*
      // sponsors map to bill_details.primary_sponsor_id (an officials FK).
      sponsor: string;
      cosponsors?: string[];
      summary_plain: string;
      sections?: string[];
      outcome?: string;
      // Open / in-deliberation proposals (S2 CM-22, HB-09, CM-15, …) carry NO
      // votes; closed ones carry a roll call whose tally decides enacted/failed.
      votes?: Array<{ official: string; vote: string; note?: string }>;
      vote_question?: string;
      chamber: string;
    }
  >;
}
interface Citizens {
  citizens: Array<Json & { seed_key: string; handle: string }>;
}
interface Positions {
  // S1/S2 carry `statement` (a free rationale, stored in conditions_md for lack of
  // a dedicated column). The horizontal positions-plus file adds an explicit
  // `conditions` key (nullable) for genuine conditional support — when present it
  // takes precedence so the rollup's pct_with_conditions aggregate stays honest.
  positions: Array<
    Json & { seed_key: string; author: string; proposal: string; stance: string; statement: string; conditions?: string | null }
  >;
}
interface Threads {
  comments: Array<
    Json & {
      seed_key: string;
      author: string;
      parent: string | null;
      kind: string;
      // S1 comments all anchor on prop-hb14 (no entity_id field → fallback);
      // S2 comments carry an explicit per-comment entity_id (prop-cm22, …).
      entity_id?: string;
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
      // S2 inv-2 carries living_individual sensitivity (narrative-level; the
      // schema has no sensitivity column — un-promotability is enforced by
      // status='proposed', recorded in metadata for the record).
      subject_sensitivity?: string;
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
          sensitivity?: string;
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
      linked_proposal: string | null;
      // null for a live 'mobilise' drive (S2 init-open-books) — only set once
      // the initiative resolves (sponsored | declined | withdrawn | expired).
      resolution_type: string | null;
      primary_author: string;
      summary: string;
      issue_area_tags?: string[];
      signature_threshold?: number;
      mobilise_started_at?: string;
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

// ── Horizontal-coverage logical shapes (FIX-613) ────────────────────────────
// A persuasion delta: seed a prior stance, then an attributed stance change that
// credits a comment (bumps that comment's rating_summary.deltas via the trigger).
interface PositionDeltas {
  deltas: Array<
    Json & {
      seed_key: string;
      author: string;
      proposal: string;
      from_stance: string;
      to_stance: string;
      attributed_comment: string;
      note?: string;
    }
  >;
}
// Polis-lite statements. vote_summary is AUTHORED display only (no real ballots —
// synthetic votes confer no standing); source_comment optionally promotes a comment.
interface Statements {
  statements: Array<
    Json & {
      seed_key: string;
      entity_id: string;
      author: string;
      source_comment: string | null;
      body: string;
      vote_summary: { agree: number; pass: number; disagree: number };
    }
  >;
}
// Citizen↔official Q&A. Questions are kind='question' on an official entity;
// answers (kind='answer', author=off-*) post through submit_comment as that
// official's synthetic office-account grant holder.
interface QA {
  qa: Array<
    Json & {
      seed_key: string;
      kind: string;
      author: string;
      entity_id: string;
      parent: string | null;
      body: string;
      want_count?: number;
    }
  >;
}
// Follows: per-entity follower counts + Desk Watching. Data-only INSERTs.
interface Follows {
  user_follows: Array<Json & { user: string; entity_type: string; entity: string }>;
  initiative_follows: Array<Json & { user: string; initiative: string }>;
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
// Resolve a logical comment `kind` to a valid entity_comments.kind. Legacy S1/S2
// threads (+ fixtures) carry the sentinel "comment" (and the horizontal file
// omits/sets real kinds); both "comment" and empty/missing collapse to the
// DEFAULT_KIND. Any other value is validated strictly against the per-entity-type
// ALLOWED_KINDS (the same allowlist submit_comment enforces) and throws on a
// typo rather than silently coercing it.
function resolveKind(raw: string | undefined, entityType: EntityCommentType, seedKey: string): string {
  const k = (raw ?? "").trim();
  if (k === "" || k === "comment") return DEFAULT_KIND;
  if (!ALLOWED_KINDS[entityType].includes(k)) {
    throw new Error(`franklin seed: comment ${seedKey} has kind "${k}" not allowed for entity_type "${entityType}"`);
  }
  return k;
}
// Map a logical edge relationship_kind to the assertable connection_type subset
// the add_evidence_card RPC accepts. S1's money-flow kinds ("funds",
// "contributes_to") are 'donation'; S2's revolving-door board seat
// ("board_member", off-sterns → Aerie Grid) is 'revolving_door'.
function edgeRelationshipKind(kind: string | undefined): string {
  switch (kind) {
    case "board_member":
      return "revolving_door";
    case "funds":
    case "contributes_to":
    default:
      return "donation";
  }
}

// A proposal's chamber string resolves the governing body + jurisdiction it
// belongs to. S2 introduces council measures (CM-*) voted at the Watauga City
// Council; S1 bills (HB-*) sit at the unicameral General Assembly.
const CHAMBER_TO_BODY: Record<string, { gb: string; juris: string }> = {
  "Franklin General Assembly": { gb: "gb-assembly", juris: "juris-franklin" },
  "Watauga City Council": { gb: "gb-watauga-council", juris: "juris-watauga" },
};

// closed proposals: enacted if the roll call passed (yes > no), else failed.
// open proposals keep 'open_comment'. Backward-compatible with S1 (HB-03's
// 4–6 → failed; HB-14 is open_comment so untouched).
function proposalStatus(status: string, votes: Array<{ vote: string }>): string {
  if (status === "open_comment") return "open_comment";
  const yes = votes.filter((v) => v.vote === "yes").length;
  const no = votes.filter((v) => v.vote === "no").length;
  return yes > no ? "enacted" : "failed";
}

// comment-window label → a concrete comment_period_end. closing_soon is a near
// future date (live but ending); closed is in the past.
function commentPeriodEnd(window: string): string {
  if (window === "open") return "2026-12-31";
  if (window === "closing_soon") return "2026-07-15";
  return "2026-04-10"; // 'closed' (and any unknown) → past
}

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

// ---------------------------------------------------------------------------
// Prod connection string (FIX-611) — sourced from env, never the CLI.
//
// Passing the prod password as a --db-url CLI arg leaks it into terminal
// scrollback, shell history, and the session log. Mirror the db:push:prod
// wrapper instead: read SUPABASE_DB_PASSWORD from .env.local.prod and inject it
// into the CLI-cached session-pooler URL inside this process. --db-url remains a
// fallback; redactDbUrl() scrubs the password from anything we print.
// ---------------------------------------------------------------------------
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PROD_ENV_FILE = join(REPO_ROOT, ".env.local.prod");
const POOLER_FILE = join(REPO_ROOT, "supabase", ".temp", "pooler-url");
const PROD_PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROD_PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

function readEnvVar(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

/** Replace the password component of a postgres URL with **** for safe logging. */
function redactDbUrl(url: string): string {
  return url.replace(/(postgresql:\/\/[^/@:]+:)[^@]+(@)/i, "$1****$2");
}

/**
 * Build the prod connection string from .env.local.prod (password) injected into
 * the cached session-pooler URL. Throws if the password is absent so a prod run
 * fails loudly rather than silently falling back to local.
 */
function buildProdDbUrl(): string {
  const password = readEnvVar(PROD_ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    throw new Error(
      `--allow-prod set but SUPABASE_DB_PASSWORD not found in ${PROD_ENV_FILE}.\n` +
        "Cannot build the prod connection string from env. Either populate that file or\n" +
        "pass --db-url explicitly (the password will then appear on the CLI — avoid that).",
    );
  }
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  // Insert the password between user and host: scheme://user@host → scheme://user:pass@host
  const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (!url.includes("@") || url === baseUrl) {
    throw new Error(`could not inject password into pooler URL: ${redactDbUrl(baseUrl)}`);
  }
  return url;
}

interface Args {
  dbUrl: string;
  allowProd: boolean;
  refreshAllMvs: boolean;
}
function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let explicitDbUrl: string | null = process.env.SUPABASE_DB_URL ?? null;
  let allowProd = false;
  let refreshAllMvs = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) explicitDbUrl = args[++i];
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--refresh-all-mvs") refreshAllMvs = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: data:seed:franklin [--allow-prod] [--db-url <url>] [--refresh-all-mvs]");
      console.log("  --allow-prod   seed PRODUCTION; password is read from .env.local.prod (never the CLI)");
      console.log("  --db-url <url> explicit connection string (fallback; password appears on the CLI — avoid)");
      process.exit(0);
    }
  }
  // Connection-string precedence (FIX-611):
  //   1. explicit --db-url / SUPABASE_DB_URL — fallback override, redacted in logs
  //   2. --allow-prod — build prod URL from .env.local.prod (password never on CLI)
  //   3. default — local Docker
  let dbUrl: string;
  if (explicitDbUrl) dbUrl = explicitDbUrl;
  else if (allowProd) dbUrl = buildProdDbUrl();
  else dbUrl = LOCAL_DB_URL;
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

async function seedProposalsAndVotes(ctx: SeedCtx, p: Proposals): Promise<void> {
  for (const prop of p.proposals) {
    const votes = prop.votes ?? [];
    const body = CHAMBER_TO_BODY[prop.chamber] ?? CHAMBER_TO_BODY["Franklin General Assembly"];
    const jurisId = ctx.id(body.juris);
    const gbId = ctx.id(body.gb);
    // Only official sponsors map to the bill_details.primary_sponsor_id FK; an
    // agency sponsor (CM-24 → ag-watauga-planning) is null there but preserved
    // in proposal metadata.sponsor.
    const sponsorId = prop.sponsor.startsWith("off-") ? ctx.id(prop.sponsor) : null;
    const status = proposalStatus(prop.status, votes);
    const propId = await upsertById(
      ctx,
      prop.seed_key,
      "proposals",
      {
        type: "bill",
        status,
        jurisdiction_id: jurisId,
        governing_body_id: gbId,
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
          comment_period_end: commentPeriodEnd(prop.comment_window),
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
      [propId, prop.bill_number, prop.chamber, jurisId, sponsorId],
    );
    await ctx.record(`${prop.seed_key}:bill_details`, "bill_details", propId);

    const rollCallId = `franklin-${prop.seed_key}-passage`;
    for (const v of votes) {
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
          vote_question: prop.vote_question ?? "On Passage",
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
    // conditions_md: the explicit `conditions` key wins when present (horizontal
    // positions-plus, where null means "no conditions" → honest NULL in the
    // aggregate); legacy rows without the key fall back to `statement`.
    const conditionsMd = "conditions" in p ? (p.conditions ?? null) : p.statement;
    await ctx.query(
      `INSERT INTO public.entity_positions (user_id, entity_type, entity_id, stance, conditions_md)
       VALUES ($1, 'proposal', $2, $3, $4)
       ON CONFLICT (user_id, entity_type, entity_id)
         DO UPDATE SET stance = EXCLUDED.stance, conditions_md = EXCLUDED.conditions_md`,
      [ctx.id(p.author), ctx.id(p.proposal), stanceToSmallint(p.stance), conditionsMd],
    );
  }
}

async function seedThread(ctx: SeedCtx, t: Threads, hb14: string): Promise<void> {
  for (const c of t.comments) {
    // S1 comments have no entity_id (all anchor on HB-14); S2 comments carry
    // their own per-comment entity_id (the four S2 proposal threads).
    const entityId = c.entity_id ? ctx.id(c.entity_id) : hb14;
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
        entity_id: entityId,
        parent_id: parentId,
        thread_root_id: threadRoot,
        author_id: ctx.id(c.author),
        kind: resolveKind(c.kind, "proposal", c.seed_key),
        body: c.body,
        status: "visible",
        bridge_score: c.bridge_score ?? null,
        map_x: c.map_x ?? null,
        map_y: c.map_y ?? null,
        rating_summary: jb(c.authored_raters ?? {}),
        metadata: jb({ seed_key: c.seed_key, is_bridge_moment: c.is_bridge_moment ?? null, note: c.note ?? null }),
      },
      new Set(["rating_summary", "metadata"]),
    );
  }
}

// ── Horizontal coverage (FIX-613) ──────────────────────────────────────────

// Persuasion deltas: drive a real attributed position change through
// set_entity_position so its trigger bumps the credited comment's
// rating_summary.deltas. Must run AFTER seedThread (the attributed comment must
// exist). Idempotent via a seed_map key on the resulting position_event.
async function seedDeltas(ctx: SeedCtx, d: PositionDeltas): Promise<void> {
  for (const delta of d.deltas) {
    const userId = ctx.id(delta.author);
    const entityId = ctx.id(delta.proposal);
    const commentId = ctx.id(delta.attributed_comment);
    if (!ctx.has(delta.seed_key)) {
      // append-only event — create once. Both calls in one impersonated tx:
      // establish the prior stance (required for attribution), then the attributed
      // change that credits the comment (its trigger bumps rating_summary.deltas).
      const fromStance = stanceToSmallint(delta.from_stance);
      const toStance = stanceToSmallint(delta.to_stance);
      await ctx.withAuthor(userId, async () => {
        await ctx.query(`SELECT public.set_entity_position('proposal', $1, $2::smallint)`, [entityId, fromStance]);
        await ctx.query(
          `SELECT public.set_entity_position('proposal', $1, $2::smallint, NULL, $3, $4)`,
          [entityId, toStance, commentId, delta.note ?? null],
        );
      });
      const ev = await ctx.one<{ id: string }>(
        `SELECT id FROM public.position_events
          WHERE user_id = $1 AND entity_id = $2 AND attributed_comment_id = $3
          ORDER BY created_at DESC LIMIT 1`,
        [userId, entityId, commentId],
      );
      await ctx.record(delta.seed_key, "position_events", ev.id);
    }
    // Self-heal the denormalized deltas EVERY run: seedThread re-runs UPDATE the
    // attributed comment's rating_summary wholesale from authored_raters, which
    // clobbers the trigger-maintained deltas key (project_rating_summary_trigger_
    // clobbers_keys). Re-derive it from the true attributed-event count so a
    // re-seed never loses the showcase delta. Idempotent regardless of order.
    await ctx.query(
      `UPDATE public.entity_comments
          SET rating_summary = jsonb_set(
                COALESCE(rating_summary, '{}'::jsonb), '{deltas}',
                to_jsonb((SELECT count(*) FROM public.position_events
                           WHERE attributed_comment_id = $1)::int), true)
        WHERE id = $1`,
      [commentId],
    );
  }
}

// Polis-lite statements: direct entity_statements insert (seed_key-keyed). The
// vote_summary trigger only fires on statement_votes, so authored counts persist
// untouched — synthetic votes confer no standing (same rule as bridge scores).
async function seedStatements(ctx: SeedCtx, s: Statements): Promise<void> {
  for (const st of s.statements) {
    const vs = st.vote_summary;
    await upsertById(
      ctx,
      st.seed_key,
      "entity_statements",
      {
        entity_type: "proposal",
        entity_id: ctx.id(st.entity_id),
        body: st.body,
        author_id: ctx.id(st.author),
        source_comment_id: st.source_comment ? ctx.id(st.source_comment) : null,
        status: "visible",
        vote_summary: jb({ agree: vs.agree, disagree: vs.disagree, pass: vs.pass }),
        metadata: jb({ seed_key: st.seed_key, authored_votes: true }),
      },
      new Set(["vote_summary", "metadata"]),
    );
  }
}

// Citizen↔official Q&A. Questions: direct entity_comments insert on the OFFICIAL
// entity (want_count → rating_summary.valuable_up, which get_entity_questions
// reads). Answers: posted through submit_comment as a synthetic office-account
// user that holds an active 'official' grant — exercising the real answer-gate
// rather than bypassing it.
async function seedQA(ctx: SeedCtx, qa: QA): Promise<void> {
  // Pass 1 — questions (must exist before their answers reply to them).
  for (const item of qa.qa) {
    if (item.kind !== "question") continue;
    await upsertById(
      ctx,
      item.seed_key,
      "entity_comments",
      {
        entity_type: "official",
        entity_id: ctx.id(item.entity_id),
        parent_id: null,
        thread_root_id: null,
        author_id: ctx.id(item.author),
        kind: "question",
        body: item.body,
        status: "visible",
        bridge_score: null,
        // want-answered signal: get_entity_questions reads rating_summary.valuable_up.
        rating_summary: jb(item.want_count != null ? { valuable_up: item.want_count } : {}),
        metadata: jb({ seed_key: item.seed_key }),
      },
      new Set(["rating_summary", "metadata"]),
    );
  }
  // Pass 2 — answers via the office-account grant holder + submit_comment.
  for (const item of qa.qa) {
    if (item.kind !== "answer") continue;
    if (ctx.has(item.seed_key)) continue; // submit_comment generates the id once
    if (!item.parent) throw new Error(`franklin seed: answer ${item.seed_key} has no parent question`);
    const officialId = ctx.id(item.entity_id); // answer.entity_id IS the official
    const officeUserId = await ensureOfficeAccount(ctx, item.author, officialId);
    const parentId = ctx.id(item.parent);
    const row = await ctx.withAuthor(officeUserId, async () =>
      ctx.one<{ id: string }>(
        `SELECT (public.submit_comment('official', $1, $2, 'answer', NULL, $3, NULL)).id AS id`,
        [officialId, item.body, parentId],
      ),
    );
    await ctx.record(item.seed_key, "entity_comments", row.id);
    await ctx.query(`UPDATE public.entity_comments SET metadata = metadata || $2::jsonb WHERE id = $1`, [
      row.id,
      jb({ seed_key: item.seed_key }),
    ]);
  }
}

// A synthetic per-official "office account" user holding an active 'official'
// grant — the seed stand-in for the verified official who answers questions
// (officials aren't users). Keyed on the official's seed_key so re-runs reuse it.
async function ensureOfficeAccount(ctx: SeedCtx, officialSeedKey: string, officialId: string): Promise<string> {
  const officeKey = `office:${officialSeedKey}`;
  const name = await ctx.one<{ full_name: string }>(`SELECT full_name FROM public.officials WHERE id = $1`, [officialId]);
  const userId = await upsertUser(ctx, officeKey, name.full_name, {
    office_account: true,
    official_seed_key: officialSeedKey,
  });
  await ctx.query(
    `INSERT INTO public.entity_grants (user_id, target_type, target_id, role, status, granted_at)
     VALUES ($1, 'official', $2, 'official', 'active', $3)
     ON CONFLICT (user_id, role, target_type, target_id) WHERE status = 'active' DO NOTHING`,
    [userId, officialId, SEED_EPOCH],
  );
  return userId;
}

// Follows: per-entity follower counts + Desk Watching. Data-only idempotent
// inserts (composite PK / UNIQUE → ON CONFLICT DO NOTHING; reset cascades via the
// synthetic users / proposals deletes).
async function seedFollows(ctx: SeedCtx, f: Follows): Promise<void> {
  for (const fl of f.user_follows) {
    await ctx.query(
      `INSERT INTO public.user_follows (user_id, entity_type, entity_id)
       VALUES ($1, $2::follow_entity_type, $3)
       ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING`,
      [ctx.id(fl.user), fl.entity_type, ctx.id(fl.entity)],
    );
  }
  for (const fl of f.initiative_follows) {
    await ctx.query(
      `INSERT INTO public.civic_initiative_follows (initiative_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (initiative_id, user_id) DO NOTHING`,
      [ctx.id(fl.initiative), ctx.id(fl.user)],
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
        it.resolution_type, // null for a live 'mobilise' drive
        it.signature_threshold ?? 25,
        it.issue_area_tags ?? [],
        it.mobilise_started_at ?? "2026-03-15",
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
      `UPDATE public.investigations
         SET is_synthetic = true, is_seeded = true, is_featured = true,
             metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [invId, jb({ seed_key: investigation.seed_key, subject_sensitivity: investigation.subject_sensitivity ?? null })],
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
            // from_type is derived (S2 ec-23's source is an official, not a
            // financial_entity) — not hardcoded.
            isEdge ? edgeToType(card.from!) : null,
            isEdge && card.from ? ctx.id(card.from) : null,
            isEdge ? edgeToType(card.to!) : null,
            isEdge && card.to ? ctx.id(card.to) : null,
            isEdge ? edgeRelationshipKind(card.relationship_kind) : null,
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
      await ctx.query(
        `UPDATE public.evidence_cards SET is_synthetic = true, metadata = metadata || $2::jsonb WHERE id = $1`,
        [cardId, jb({ seed_key: card.seed_key, sensitivity: card.sensitivity ?? null })],
      );

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

    // S1 + S2 are ingested through one pass over the merged logical set; the
    // franklin_seed_map keys every row on its seed_key, so order within a slice
    // and re-runs are both idempotent. S2 is ADDITIVE: it reuses S1 entities,
    // money, citizens, and fixtures (no new files for those) and only extends
    // proposals / positions / threads / investigations / initiatives.
    //
    // s2/qa.json (agency Q&A) is DEFERRED (FIX-610): no agency Q&A surface
    // exists yet (get_entity_questions + QASection + the /api routes are
    // officials-only). Seeding it today would be invisible. The file is
    // co-located here, ready to wire once the surface ships.
    const entities = loadJson<Entities>("entities.json");
    const money = loadJson<MoneyGraph>("money-graph.json");
    const citizens = loadJson<Citizens>("citizens.json");
    const fixtures = loadJson<Fixtures>("fixtures.json");

    const proposals: Proposals = {
      proposals: [
        ...loadJson<Proposals>("proposals.json").proposals,
        ...loadJson<Proposals>("s2/proposals.json").proposals,
      ],
    };
    const positions: Positions = {
      positions: [
        ...loadJson<Positions>("positions.json").positions,
        ...loadJson<Positions>("s2/positions.json").positions,
      ],
    };
    const threads: Threads = {
      comments: [
        ...loadJson<Threads>("threads.json").comments,
        ...loadJson<Threads>("s2/threads.json").comments,
        // Horizontal coverage (FIX-613): the 10 distinct comment KINDS. Same
        // Threads shape (per-comment entity_id + kind); seedThread reads kind now.
        ...loadJson<Threads>("horizontal/comments-kinds.json").comments,
      ],
    };
    const investigations: Investigations = {
      investigations: [
        ...loadJson<Investigations>("investigations.json").investigations,
        ...loadJson<Investigations>("s2/investigations.json").investigations,
      ],
    };
    const initiatives: Initiatives = {
      initiatives: [
        ...loadJson<Initiatives>("initiatives.json").initiatives,
        ...loadJson<Initiatives>("s2/initiatives.json").initiatives,
      ],
    };

    // Horizontal-coverage files (FIX-613) — additive surfaces over S1/S2 entities.
    const positionDeltas = loadJson<PositionDeltas>("horizontal/positions-plus.json");
    const statements = loadJson<Statements>("horizontal/statements.json");
    const qa = loadJson<QA>("horizontal/qa-officials.json");
    const follows = loadJson<Follows>("horizontal/follows.json");
    // positions-plus also carries additional citizen positions (to cross the
    // rollup min-n) under `positions` — fold them into the positions set.
    positions.positions.push(...loadJson<Positions>("horizontal/positions-plus.json").positions);

    console.log("1-4  entities (jurisdictions, bodies, agencies, officials)…");
    await seedEntities(ctx, entities);
    console.log("5-6  money graph (entities + relationships)…");
    await seedMoney(ctx, money);
    console.log("7-8  proposals + bill_details + votes (assembly + council)…");
    await seedProposalsAndVotes(ctx, proposals);
    console.log("10   citizen + curator + fixture-author users…");
    await upsertUser(ctx, "user-curator", "Franklin Commons", { role: "curator", is_curator: true });
    await seedCitizens(ctx, citizens);
    console.log("9    initiative (proposal + details + signatures + responses)…");
    await seedInitiative(ctx, initiatives);
    console.log("11   positions…");
    await seedPositions(ctx, positions);
    console.log("12   threads (HB-14 B-1; S2 CM-22/HB-09/CM-15/CM-19 B-2/B-3/B-4; +10 kinds)…");
    await seedThread(ctx, threads, ctx.id("prop-hb14"));
    console.log("12b  position deltas (attributed persuasion → comment.deltas)…");
    await seedDeltas(ctx, positionDeltas);
    console.log("12c  statements (Polis-lite quick-takes + authored vote_summary)…");
    await seedStatements(ctx, statements);
    console.log("12d  Q&A lane (citizen questions + office-account official answers)…");
    await seedQA(ctx, qa);
    console.log("12e  follows (user_follows + civic_initiative_follows)…");
    await seedFollows(ctx, follows);
    console.log("13   moderation fixtures + content_flags (≥3 → needs_review)…");
    await seedFixtures(ctx, fixtures);
    console.log("14   Investigations #1 + #2 (evidence cards + citations + promotion)…");
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
  // Defensive: scrub any postgres://user:pass@ that leaks into an error string
  // (pg connect errors, our own thrown messages) before it reaches the log.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(redactDbUrl(msg));
  process.exit(1);
});
