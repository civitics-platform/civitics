/**
 * FIX-560 — the claim-outcome notification's SHAPE, as a pure function.
 *
 * /api/admin/grants/[id] (approve / reject) and /api/officials/claim (the
 * exact-email auto-approve fast path) all end a claim's life without telling
 * the claimant anything: they write entity_grants, grant_evidence and
 * grant_events, and the outcome was visible only by re-polling
 * /api/officials/claim-status. This builds the createNotification() payload
 * those three call sites send.
 *
 * It is pure so the copy and the entity mapping are testable without a DB or a
 * route — see claim-notification.test.ts. The routes own the insert; this owns
 * what goes in it.
 *
 * FIX-1205 — the third outcome, `revoked`: the admin route's revoke action
 * (FIX-928) withdraws LIVE access and used to tell the holder nothing. It
 * reuses the `claim_outcome` event type (no enum migration): the readers
 * render title/body/link only, and a revocation ends a grant's life exactly as
 * the other two do. One revoke_grant() call yields ONE notification —
 * `user_id` is part of the key it revokes on, so every row it flips belongs to
 * the same holder.
 *
 * TWO VOCABULARIES THAT DO NOT LINE UP
 * ------------------------------------
 * grant_target_type is  global | jurisdiction | official | institution
 * follow_entity_type is official | agency | jurisdiction
 *
 * notifications.entity_type is follow_entity_type and is NULLable, so the two
 * targets with no follow_entity_type counterpart ('global', 'institution')
 * produce a notification with no entity rather than no notification. Dropping
 * the notification instead would reintroduce the exact silence FIX-560 is
 * about, for precisely the grants that carry the most access.
 */

/** The grant columns this needs. Matches the route's existing select. */
export interface ClaimGrant {
  user_id: string;
  role: string;
  target_type: string;
  target_id: string | null;
}

export type ClaimOutcome = "approved" | "rejected" | "revoked";

/** Exactly the createNotification() argument object. */
export interface ClaimOutcomeNotification {
  userId: string;
  eventType: "claim_outcome";
  title: string;
  body: string;
  link?: string;
  entityType?: "official" | "agency" | "jurisdiction";
  entityId?: string;
}

/**
 * grant_target_type → follow_entity_type, or null when the vocabularies do not
 * overlap. 'global' and 'institution' have no counterpart today.
 */
export function followEntityTypeFor(
  targetType: string,
): "official" | "agency" | "jurisdiction" | null {
  if (targetType === "official") return "official";
  if (targetType === "jurisdiction") return "jurisdiction";
  return null;
}

/** Human-readable role, for the body. Unknown roles pass through unchanged. */
function roleLabel(role: string): string {
  switch (role) {
    case "official":
      return "official";
    case "platform_admin":
      return "platform admin";
    case "jurisdiction_admin":
      return "jurisdiction admin";
    case "institution_admin":
      return "institution admin";
    case "verified_human":
      return "verified human";
    default:
      return role.replace(/_/g, " ");
  }
}

/** Title and body per outcome. `subject` is "<role> access[ to <target>]". */
const COPY: Record<ClaimOutcome, { title: string; body: (subject: string) => string }> = {
  approved: {
    title: "Your claim was approved",
    body: (s) => `Your request for ${s} was approved and is now active.`,
  },
  rejected: {
    title: "Your claim was not approved",
    body: (s) => `Your request for ${s} was reviewed and not approved.`,
  },
  revoked: {
    title: "Your access was revoked",
    body: (s) => `Your ${s} has been revoked by an administrator.`,
  },
};

/**
 * Build the notification for a grant that has just been approved, rejected or
 * revoked.
 *
 * `targetName` is the official's full_name when the target is an official and
 * the lookup succeeded. It is optional on purpose: a failed name read must not
 * cost the claimant the notification, so the body degrades to the role alone.
 */
export function buildClaimOutcomeNotification(
  grant: ClaimGrant,
  outcome: ClaimOutcome,
  targetName?: string | null,
): ClaimOutcomeNotification {
  const label = roleLabel(grant.role);
  const subject = targetName ? `${label} access to ${targetName}` : `${label} access`;

  const notification: ClaimOutcomeNotification = {
    userId: grant.user_id,
    eventType: "claim_outcome",
    title: COPY[outcome].title,
    body: COPY[outcome].body(subject),
  };

  // Link only where a page exists to link to. An official target has
  // /officials/<id>; 'global', 'institution' and 'jurisdiction' claims are
  // reviewed elsewhere, and a link that 404s is worse than no link.
  if (grant.target_type === "official" && grant.target_id) {
    notification.link = `/officials/${grant.target_id}`;
  }

  const entityType = followEntityTypeFor(grant.target_type);
  if (entityType && grant.target_id) {
    notification.entityType = entityType;
    notification.entityId = grant.target_id;
  }

  return notification;
}
