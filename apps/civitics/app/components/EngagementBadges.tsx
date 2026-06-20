/**
 * EngagementBadges — FIX-618 / SF engagement (PR B). Up to three independent,
 * DISPLAY-ONLY badges for an accountable entity, read from
 * entity_engagement_rollup_mv:
 *
 *   Claimed          — an active answerer grant exists (brand verification stamp).
 *   Engaged          — the office responds (tiered: Responsive / Highly responsive).
 *   Active community — recent citizen activity (tiered: Active / Thriving).
 *
 * Generic over { official | institution | jurisdiction } so PR B2 drops it onto
 * institution/jurisdiction/governing-body cards with no rework. These badges
 * NEVER feed standing — they are presentation only.
 *
 * Token-styled, paper mode. The Claimed pill reuses the brand `.stampb`
 * green-ink verification idiom (FIX-564, ClaimProfileSection / StampMark); the
 * Engaged + Active-community pills are quiet civic-blue / ink pills so the
 * verification stamp stays the loudest signal on the card.
 */
import { StampMark } from "./brand/StampMark";
import {
  type EngagementEntityType,
  type EngagedTier,
  type CommunityTier,
} from "../lib/engagement";

// Green-ink verification stamp, same `.stampb` idiom as ClaimProfileSection's
// "claimed/verified" state — bordered, letterspaced mono caps.
const CLAIMED_STAMP =
  "inline-flex items-center gap-1 rounded-[2px] border-[1.5px] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] border-green-ink/50 text-green-ink bg-green-ink/10";

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none";

// Engaged = responsiveness → civic-blue (signal, not alarm). Top tier filled.
const ENGAGED_STYLE: Record<"high" | "base", string> = {
  high: "bg-civic-blue text-paper",
  base: "bg-civic-blue/10 text-civic-blue",
};

// Active community = people, quieter ink pill so it doesn't compete with Engaged.
const COMMUNITY_STYLE: Record<"high" | "base", string> = {
  high: "bg-ink text-paper",
  base: "bg-ink/5 text-ink-soft",
};

export type EngagementBadgesProps = {
  entityType: EngagementEntityType;
  isClaimed: boolean;
  engaged: EngagedTier;
  community: CommunityTier;
  className?: string;
};

const CLAIMED_TITLE: Record<EngagementEntityType, string> = {
  official: "This profile is claimed by its officeholder — they can answer questions here.",
  institution: "This institution is claimed by an administrator who can answer questions here.",
  jurisdiction: "This jurisdiction is claimed by a clerk who can answer questions here.",
};

export function EngagementBadges({
  entityType,
  isClaimed,
  engaged,
  community,
  className = "",
}: EngagementBadgesProps) {
  // Nothing to show → render nothing (no empty container, no layout shift).
  if (!isClaimed && !engaged && !community) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {isClaimed && (
        <span className={CLAIMED_STAMP} title={CLAIMED_TITLE[entityType]}>
          <StampMark size={10} />
          Claimed
        </span>
      )}
      {engaged && (
        <span
          className={`${PILL_BASE} ${ENGAGED_STYLE[engaged.level]}`}
          title="Answers questions from citizens on this profile."
        >
          {engaged.label}
        </span>
      )}
      {community && (
        <span
          className={`${PILL_BASE} ${COMMUNITY_STYLE[community.level]}`}
          title="Citizens are actively discussing and asking questions here."
        >
          {community.label}
        </span>
      )}
    </div>
  );
}
