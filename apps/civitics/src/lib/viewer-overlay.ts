"use client";

// FIX-788 — client half of the cached-list / viewer-overlay split.
//
// /api/statements and /api/questions are edge-cached and viewer-independent;
// the signed-in viewer's own state (statement ballots, Q&A can_answer) comes
// from the no-store /api/viewer/engagement overlay and is merged onto the
// already-rendered rows. Signed-out users have no votes and no grants, so this
// helper short-circuits on the LOCAL session check and makes ZERO network
// calls for them — that anon majority is exactly the traffic the edge cache
// now absorbs.
//
// Failure-tolerant by design: any error returns the empty overlay, which
// renders identically to a signed-out viewer (list intact, no vote state).

import { createBrowserClient } from "@civitics/db";

export type ViewerRating = { agree: number; valuable: number };

export type ViewerEngagement = {
  /** statement_id → the caller's ballot (-1 | 0 | 1). */
  votes: Record<string, number>;
  /** comment_id → the caller's two-axis rating (FIX-798). Serves discussion
   *  ratings, Q&A "want answered" marks and community-note ratings. */
  ratings: Record<string, ViewerRating>;
  /** Caller holds the active answerer grant for the requested entity. */
  can_answer: boolean;
};

const EMPTY: ViewerEngagement = { votes: {}, ratings: {}, can_answer: false };

export async function fetchViewerEngagement(params: {
  statementIds?: string[];
  commentIds?: string[];
  entityType?: string;
  entityId?: string;
}): Promise<ViewerEngagement> {
  const { statementIds, commentIds, entityType, entityId } = params;
  const wantsVotes = (statementIds?.length ?? 0) > 0;
  const wantsRatings = (commentIds?.length ?? 0) > 0;
  const wantsGrant = Boolean(entityType && entityId);
  if (!wantsVotes && !wantsRatings && !wantsGrant) return EMPTY;

  try {
    // Local read (cookie/storage) — no network round-trip for anon visitors.
    const { data: { session } } = await createBrowserClient().auth.getSession();
    if (!session) return EMPTY;

    const sp = new URLSearchParams();
    if (wantsVotes) sp.set("statement_ids", statementIds!.join(","));
    if (wantsRatings) sp.set("comment_ids", commentIds!.join(","));
    if (wantsGrant) {
      sp.set("entity_type", entityType!);
      sp.set("entity_id", entityId!);
    }
    const res = await fetch(`/api/viewer/engagement?${sp.toString()}`);
    if (!res.ok) return EMPTY;
    const json = (await res.json().catch(() => null)) as Partial<ViewerEngagement> | null;
    return {
      votes:
        json?.votes && typeof json.votes === "object"
          ? (json.votes as Record<string, number>)
          : {},
      ratings:
        json?.ratings && typeof json.ratings === "object"
          ? (json.ratings as Record<string, ViewerRating>)
          : {},
      can_answer: json?.can_answer === true,
    };
  } catch {
    return EMPTY;
  }
}
