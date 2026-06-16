import { DistrictPickerForm } from "../../profile/DistrictPickerForm";
import { VerifyConstituentForm } from "../../profile/VerifyConstituentForm";

export type VerifiedJurisdiction = { id: string; name: string };
export type OfficialClaim = {
  id: string;
  target_id: string;
  status: string;
  expires_at: string | null;
  name: string;
};

/**
 * Verification — the Desk's identity surface (subsumes the old /profile).
 * Constituent grant state + official-claim state (logic lifted from
 * profile/page.tsx), the constituent verify form, and the district picker.
 */
export function VerificationModule({
  verifiedJurisdictions,
  earliestExpiry,
  officialClaims,
  initialState,
  initialDistrict,
}: {
  verifiedJurisdictions: VerifiedJurisdiction[];
  earliestExpiry: string | null;
  officialClaims: OfficialClaim[];
  initialState: string | null;
  initialDistrict: number | null;
}) {
  return (
    <section className="border border-rule bg-paper p-5 sm:p-6">
      <h2 className="font-serif text-lg font-semibold text-ink">Verification &amp; identity</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Verified constituents are recognized on the record. Your address is used once to determine
        your jurisdictions and is not stored.
      </p>

      {/* Constituent state — verified card, else the verify form */}
      {verifiedJurisdictions.length > 0 ? (
        <div className="mt-5 border border-accent/40 bg-paper-2 p-5">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-accent">
            Verified constituent
          </p>
          <p className="mt-1.5 text-sm text-ink">
            Verified constituent of {verifiedJurisdictions.map((j) => j.name).join(", ")}.
            {earliestExpiry && (
              <>
                {" "}
                Expires{" "}
                {new Date(earliestExpiry).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
                .
              </>
            )}
          </p>
        </div>
      ) : (
        <VerifyConstituentForm />
      )}

      {/* Official profile claims — one row per claimed official, latest claim wins */}
      {officialClaims.length > 0 && (
        <div className="mt-6 border border-rule bg-paper p-5">
          <h3 className="font-serif text-base font-semibold text-ink">Official profile claims</h3>
          <ul className="mt-3 divide-y divide-rule">
            {officialClaims.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 py-2.5">
                <a
                  href={`/officials/${g.target_id}`}
                  className="min-w-0 truncate text-sm font-medium text-ink hover:text-accent"
                >
                  {g.name}
                </a>
                {g.status === "active" ? (
                  <span className="shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent">
                    Verified
                    {g.expires_at &&
                      ` · expires ${new Date(g.expires_at).toLocaleDateString("en-US", {
                        month: "short",
                        year: "numeric",
                      })}`}
                  </span>
                ) : g.status === "pending" ? (
                  <span className="shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
                    Under review
                  </span>
                ) : g.status === "expired" ? (
                  <span className="shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft/60">
                    Expired
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-red-700">
                    Declined
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* District picker — sets home_state/home_district for the USER graph node */}
      <DistrictPickerForm initialState={initialState} initialDistrict={initialDistrict} />
    </section>
  );
}
