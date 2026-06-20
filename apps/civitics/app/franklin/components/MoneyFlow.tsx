// FIX-621: the "Follow the money" mini-flow for HB-14.
//
// Every node and number here is read straight from financial_relationships
// donation edges among the synthetic financial_entities — donors → the opposition
// PAC → the HB-14 NO votes. The "N of M NO votes funded" figure is COMPUTED LIVE
// (intersection of the PAC's official recipients with the bill's NO-voters), not an
// asserted claim: the donor→PAC and PAC→official edges are real, queryable records.
// The full cited argument lives in the investigation — this is the signpost, that is
// the proof (decision 4). Mirrors the layout reference's "Follow the money" block.
import Link from "next/link";
import { SyntheticMark } from "../../components/integrity/Synthetic";

export type MoneyDonor = { id: string; name: string; amountCents: number | null };

export function MoneyFlow({
  pacId,
  pacName,
  donors,
  donorsTotalCents,
  noVotesFunded,
  noVotesTotal,
  graphHref,
  investigationHref,
}: {
  pacId: string;
  pacName: string;
  donors: MoneyDonor[];
  donorsTotalCents: number;
  noVotesFunded: number;
  noVotesTotal: number;
  graphHref: string;
  investigationHref: string | null;
}) {
  return (
    <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
      {/* Donors */}
      <FlowColumn label="Donors">
        {donors.map((d) => (
          <Link
            key={d.id}
            href={`/donors/${d.id}`}
            className="group block border border-rule bg-card p-3 transition-colors hover:border-accent"
          >
            <p className="font-serif text-sm font-semibold leading-tight text-ink group-hover:underline">
              {d.name}
              <SyntheticMark size="xs" className="ml-1" />
            </p>
            {d.amountCents != null && (
              <p className="mt-0.5 font-mono text-[11px] text-accent">{fmtUsd(d.amountCents)}</p>
            )}
          </Link>
        ))}
        {donors.length === 0 && (
          <p className="border border-dashed border-rule p-3 text-xs text-ink-soft/60">
            No tracked donor inflows.
          </p>
        )}
      </FlowColumn>

      <Arrow />

      {/* The PAC */}
      <FlowColumn label="Political committee">
        <Link
          href={`/donors/${pacId}`}
          className="group block border border-rule bg-card p-3 transition-colors hover:border-accent"
        >
          <p className="font-serif text-sm font-semibold leading-tight text-ink group-hover:underline">
            {pacName}
            <SyntheticMark size="xs" className="ml-1" />
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
            opposes HB-14 · {fmtUsd(donorsTotalCents)} raised
          </p>
        </Link>
      </FlowColumn>

      <Arrow />

      {/* The outcome */}
      <FlowColumn label="The vote">
        <div className="border border-rule bg-card p-3">
          <p className="font-serif text-sm font-semibold leading-tight text-ink">
            {noVotesTotal} NO votes on HB-14
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-accent">
            {noVotesFunded} of {noVotesTotal} took its money
          </p>
        </div>
        <div className="mt-1 flex flex-col gap-1">
          {investigationHref && (
            <Link
              href={investigationHref}
              className="font-mono text-[11px] text-accent hover:underline"
            >
              Read the cited investigation →
            </Link>
          )}
          <Link href={graphHref} className="font-mono text-[11px] text-accent hover:underline">
            Open the connection graph →
          </Link>
        </div>
      </FlowColumn>
    </div>
  );
}

function FlowColumn({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft/70">{label}</p>
      {children}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center text-accent" aria-hidden>
      <span className="text-lg md:rotate-0 rotate-90">→</span>
    </div>
  );
}

function fmtUsd(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${Math.round(dollars / 1000)}K`;
  return `$${dollars.toLocaleString("en-US")}`;
}
