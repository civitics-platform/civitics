// The Commons index (FIX-712) — the destination the homepage "All threads →"
// affordance points at. Read-only surface over the commons_active_threads MV
// (FIX-594): the most *bridging* root threads across the whole public record.
// Participation happens on the entity pages — there is no posting UI here.
//
// Mirrors the homepage Commons module (app/page.tsx, FIX-595): same MV, same
// ranking ORDER re-applied on the read (bridge DESC NULLS FIRST → court of
// record, NEVER re-ranked by volume), same shared label resolver (FIX-597),
// same chip set, and the same #comment-<id> anchored href per row. Server
// component, force-dynamic to match how the homepage reads the MV (cookie
// client, RLS).

export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { resolveEntityLabels, isCommonsEntityType } from "@/lib/entity-labels";
import { SyntheticMark } from "../components/integrity/Synthetic";
import { PageViewTracker } from "../components/PageViewTracker";
import type { CommonsThread } from "../components/home/types";

export const metadata: Metadata = {
  title: "The Commons | Civitics",
  description:
    "Threads anchored to the record — public deliberation on proposals, officials, agencies, and the money behind them, ranked by common ground rather than volume.",
};

// Same relative-time helper as the homepage module. Server-rendered against a
// single request-time nowIso; no client re-render, so no hydration concern.
function relativeTime(iso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const CHIP =
  "inline-flex items-center border border-rule px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft";

type CommonsRow = {
  comment_id: string;
  entity_type: string;
  entity_id: string;
  excerpt: string;
  kind: string;
  has_answer: boolean;
  reply_count: number;
  rater_count: number;
  last_activity_at: string;
  author_is_synthetic: boolean;
};

export default async function CommonsIndexPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;

  const now = new Date().toISOString();

  // MV order preserved (bridge DESC NULLS FIRST, last_activity_at DESC) — the MV
  // is already capped (~50 rows, FIX-594). Fail-soft: on timeout the list is
  // empty and the page renders its empty state.
  const commonsRes = await withDbTimeout(
    sbAny
      .from("commons_active_threads")
      .select(
        "comment_id,entity_type,entity_id,excerpt,kind,has_answer,reply_count,rater_count,last_activity_at,author_is_synthetic",
      )
      .order("bridge_score", { ascending: false, nullsFirst: false })
      .order("last_activity_at", { ascending: false })
      .limit(50),
    3000,
    "commons:index",
  );

  const commonsRows = ((commonsRes as { data: CommonsRow[] | null }).data ?? []).filter(
    (r): r is CommonsRow => isCommonsEntityType(r.entity_type),
  );

  // Shared resolver (FIX-597): one batched label query per present entity_type.
  const labels = await resolveEntityLabels(sbAny, commonsRows);
  const threads: CommonsThread[] = [];
  for (const r of commonsRows) {
    const resolved = labels.get(`${r.entity_type}:${r.entity_id}`);
    if (!resolved) continue; // unresolved entity → skip rather than link to a 404
    threads.push({
      commentId: r.comment_id,
      excerpt: r.excerpt,
      chip: resolved.chip,
      href: `${resolved.href}#comment-${r.comment_id}`,
      label: resolved.label.length > 60 ? `${resolved.label.slice(0, 57)}…` : resolved.label,
      isQuestion: r.kind === "question",
      isAnswered: r.has_answer === true,
      replyCount: Number(r.reply_count ?? 0),
      raterCount: Number(r.rater_count ?? 0),
      lastActivityAt: r.last_activity_at,
      authorIsSynthetic: r.author_is_synthetic === true,
    });
  }

  return (
    <div className="min-h-screen bg-paper">
      <PageViewTracker />
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <header className="border-b border-rule pb-6">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-accent">
            Where the record is debated
          </p>
          <h1 className="mt-1 font-serif text-3xl text-ink">The Commons</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Threads anchored to the record — public deliberation on proposals, officials, agencies,
            and the money behind them.{" "}
            <span className="font-medium text-ink">
              Ranked by common ground, never by volume.
            </span>{" "}
            To join a thread, open the entity it&apos;s anchored to.
          </p>
        </header>

        {threads.length === 0 ? (
          <p className="mt-10 text-sm text-ink-soft">No threads on the record yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-rule">
            {threads.map((t) => (
              <li key={t.commentId} className="group py-4 hover:bg-paper-2">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={CHIP}>{t.chip}</span>
                  {t.isQuestion && <span className={CHIP}>Q&amp;A</span>}
                  {t.isAnswered && (
                    <span className={`${CHIP} border-accent text-accent`}>Answered</span>
                  )}
                  {t.authorIsSynthetic && <SyntheticMark size="xs" />}
                  <span className="font-mono text-[10.5px] text-ink-soft/70">· {t.label}</span>
                </div>
                <Link
                  href={t.href}
                  className="block font-serif text-[16px] font-semibold leading-snug text-ink transition-colors group-hover:text-accent focus-visible:text-accent focus-visible:outline-none"
                >
                  {t.excerpt}
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-ink-soft">
                  <span>
                    {t.replyCount} {t.replyCount === 1 ? "reply" : "replies"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t.raterCount} {t.raterCount === 1 ? "rater" : "raters"}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{relativeTime(t.lastActivityAt, now)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
