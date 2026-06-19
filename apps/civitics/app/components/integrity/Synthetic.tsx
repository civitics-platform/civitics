/**
 * Synthetic — persistent, server-rendered, NON-DISMISSIBLE labeling for
 * AI-generated ("synthetic") civic content. SF-P2 (FIX-599), built on the
 * FIX-572 is_synthetic seam.
 *
 * The locked rule (state-of-franklin-bible §1.2/§2.4): no AI-generated entity
 * or utterance may ever be mistaken for real. These marks are:
 *   - Persistent + unremovable — server-rendered, no client dismiss handler,
 *     the viewer cannot hide them.
 *   - Actor-not-location, three scopes:
 *       SyntheticBanner             — jurisdiction scope (jurisdictions.is_synthetic)
 *       SyntheticMark               — per-entity (entity.is_synthetic) AND
 *                                     per-utterance (author.is_synthetic)
 *       PassiveOfficialDisclaimer   — records-only synthetic official (SF-P11)
 *
 * GREPPABLE BY DESIGN: every synthetic-content surface imports from this one
 * file. A future surface that renders an entity/utterance but does NOT import
 * `Synthetic` is obviously missing its label.
 *
 * Token-styled off the brand `.stampb` idiom (FIX-564, see ClaimProfileSection)
 * — amber/caution tone, distinct from the green-ink "verified" stamp. NO
 * ad-hoc colors. The StampMark (logo №5) is the brand "on the record" mark.
 *
 * These are pure server components — NO "use client", no state, no handlers —
 * so they cannot be dismissed and always render in the SSR payload.
 */
import { StampMark } from "../brand/StampMark";

// Same `.stampb` idiom as ClaimProfileSection: bordered, letterspaced mono
// caps. Amber = "demonstration / synthetic" (caution, not error, not verified).
const STAMPB =
  "inline-flex items-center gap-1.5 rounded-[2px] border-[1.5px] border-dashed px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] border-amber/70 text-ink bg-amber/25";

/**
 * SyntheticMark — the per-entity AND per-utterance marker. Render it next to
 * any entity name/title that is `is_synthetic`, and next to any utterance whose
 * AUTHOR is synthetic. Inline, compact, dotted-border + mono `SYNTHETIC`.
 *
 * Use `size="xs"` for dense card/search/list/utterance rows; the default size
 * for detail-page headers. `withIcon` adds the StampMark (default off — too
 * noisy inline; reserve for detail headers).
 */
export function SyntheticMark({
  size = "sm",
  withIcon = false,
  className = "",
  label = "Synthetic",
}: {
  size?: "xs" | "sm";
  withIcon?: boolean;
  className?: string;
  label?: string;
}) {
  const sizeCls = size === "xs" ? "text-[8.5px] px-1.5 py-0" : "";
  return (
    <span
      className={`${STAMPB} ${sizeCls} ${className} align-middle`}
      title="AI-generated demonstration content — not a real person, body, or statement."
    >
      {withIcon && <StampMark size={11} />}
      {label}
    </span>
  );
}

/**
 * SyntheticBanner — the jurisdiction-scope banner. Render at the top of a
 * synthetic jurisdiction's page, and on any entity scoped under it (an
 * official/proposal/agency whose jurisdiction is synthetic). Persistent strip;
 * no dismiss affordance.
 *
 * `scope="jurisdiction"` is the full banner for the jurisdiction itself;
 * `scope="entity"` is the one-line inherited variant for sub-entities.
 */
export function SyntheticBanner({
  scope = "jurisdiction",
  className = "",
}: {
  scope?: "jurisdiction" | "entity";
  className?: string;
}) {
  if (scope === "entity") {
    return (
      <div
        className={`flex items-center gap-2 border-l-2 border-amber/70 bg-amber/10 px-3 py-1.5 ${className}`}
      >
        <SyntheticMark size="xs" label="Demonstration" />
        <p className="text-[11px] leading-snug text-ink-soft">
          Part of a demonstration jurisdiction populated by AI — not real civic
          data.
        </p>
      </div>
    );
  }
  return (
    <div
      className={`flex items-start gap-2.5 border-[1.5px] border-dashed border-amber/70 bg-amber/10 px-4 py-3 ${className}`}
    >
      <span className="text-ink">
        <StampMark size={18} />
      </span>
      <div>
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-ink">
          Demonstration — populated by AI
        </p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          This is a fictional jurisdiction used to demonstrate the platform.
          Every official, proposal, body, and statement scoped under it is
          AI-generated and labeled <span className="font-semibold">Synthetic</span>.
          Nothing here is a real person, office, or public record.
        </p>
      </div>
    </div>
  );
}

/**
 * PassiveOfficialDisclaimer — SF-P11. For a synthetic official that is
 * records-only / non-participating (bible §4.6). Sits alongside (does NOT
 * replace) ClaimProfileSection's "Is this you?" and ResponsivenessCard's
 * "Silence is data" framing — it adds the synthetic note on top.
 */
export function PassiveOfficialDisclaimer({ className = "" }: { className?: string }) {
  return (
    <div className={`mt-4 border-[1.5px] border-dashed border-amber/70 bg-amber/10 px-4 py-3 ${className}`}>
      <span className={`${STAMPB}`}>
        <StampMark size={11} />
        Demonstration official
      </span>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
        Populated from synthetic public-record-style data. This office does not
        post or respond — everything here is record, not testimony.
      </p>
    </div>
  );
}
