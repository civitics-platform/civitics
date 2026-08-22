// FIX-880 / FIX-571 PR1 — plain-language privacy summary.
//
// Static server component, styled to match /about/sources. This is a
// plain-language summary of what Civitics collects and why — NOT a Terms of
// Service and NOT a formal privacy policy. It is deliberately scoped to the
// account-level data and the observe-only integrity log (abuse_events); it must
// stay in sync with what recordAbuseEvent() actually stores. A visible banner
// flags that a formal legal review is pending before launch.

import type { Metadata } from "next";

export const metadata: Metadata = {
  // No "| Civitics" suffix — the root layout title template appends it (FIX-1076).
  title: "Privacy",
  description:
    "What Civitics collects, why, and how long we keep it — in plain language. " +
    "Raw network identifiers are never stored; the integrity log is observe-only.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-10 border-b border-rule pb-8">
        <p className="text-xs font-semibold uppercase tracking-wider text-accent">
          Transparency
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Privacy
        </h1>
        <p className="mt-3 text-base leading-relaxed text-ink-soft">
          Civitics is civic infrastructure, not a social network — we have no
          interest in tracking you across the web, and we don&apos;t. This page
          explains, in plain language, the small amount of data we do collect,
          why we collect it, and how long we keep it.
        </p>
      </header>

      {/* ─── Pending-legal-review banner ────────────────────────────────────── */}
      <section
        aria-labelledby="pending-review"
        className="mb-12 border border-amber/60 bg-amber/20 p-5"
      >
        <h2
          id="pending-review"
          className="text-sm font-semibold uppercase tracking-wide text-ink"
        >
          Plain-language summary — pending legal review
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink">
          This is a plain-language description of our current practices, written
          to be readable rather than exhaustive. It is <strong>pending formal
          legal review before launch</strong> and is not a contract or a
          complete legal privacy policy. If anything here is unclear,{" "}
          <a
            href="mailto:civitics.platform@gmail.com"
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            ask us
          </a>
          .
        </p>
      </section>

      <div className="flex flex-col gap-10">
        {/* ─── What we collect at the account level ─────────────────────────── */}
        <Section title="What we collect when you have an account">
          <ul className="ml-4 list-disc space-y-2">
            <li>
              <span className="font-medium text-ink">Your email address</span>,
              so you can sign in and we can reach you about your account.
            </li>
            <li>
              <span className="font-medium text-ink">
                A verification address, used only in the moment
              </span>{" "}
              — if you choose to confirm you&apos;re a constituent of a place, we
              use the address to work out which district it falls in
              (geocoding), then keep the district, not the street address.
            </li>
          </ul>
          <p className="mt-3">
            Reading Civitics — browsing officials, proposals, spending, the
            graph — requires no account and is never logged to your identity.
          </p>
        </Section>

        {/* ─── The integrity log ────────────────────────────────────────────── */}
        <Section title="The integrity log — what a participation action records">
          <p>
            When you take a <span className="font-medium text-ink">participation
            action</span> — setting a position, voting on a statement, posting a
            comment or answer, flagging content, or contributing to an
            investigation — we append one row to an internal integrity log. Each
            row records:
          </p>
          <ul className="ml-4 mt-3 list-disc space-y-2">
            <li>the <span className="font-medium text-ink">type of action</span> (e.g. &ldquo;position set&rdquo;) and a <span className="font-medium text-ink">timestamp</span>;</li>
            <li>
              a <span className="font-medium text-ink">one-way, salted hash</span>{" "}
              of your network identifiers (IP address and browser
              user-agent), computed with a secret server key
              (HMAC-SHA256).
            </li>
          </ul>
          <p className="mt-3">
            We <strong>never store your raw IP address or user-agent</strong> —
            not even briefly. Only the irreversible hash is written, and the hash
            cannot be turned back into the original address. We record signing in
            (so a fresh account can be tied to its own earlier sign-ins) and the
            moments when a rate limit or bot-check fires. We do{" "}
            <strong>not</strong> log the pages you read or your browsing.
          </p>
        </Section>

        {/* ─── Why ──────────────────────────────────────────────────────────── */}
        <Section title="Why we keep it">
          <p>
            Civitics publishes public aggregates — how many constituents support
            a bill, which comments a community found valuable. Those numbers are
            only trustworthy if they resist manipulation. The salted hash lets us
            tell whether many &ldquo;different&rdquo; accounts are actually one
            person or a coordinated cluster gaming a tally, <strong>without</strong>{" "}
            ever knowing who or where you are. This linkage check runs as periodic
            automated analysis over the hashed log alone — never over your identity
            or what you wrote — and is strictly <span className="font-medium text-ink">observe-only</span>,
            surfacing candidates for human review before any consequence is ever
            considered. It is a manipulation-resistance signal for public integrity
            — nothing more.
          </p>
        </Section>

        {/* ─── Retention ────────────────────────────────────────────────────── */}
        <Section title="How long we keep it">
          <p>
            Integrity-log rows are <span className="font-medium text-ink">automatically
            deleted after 90 days</span>. There is no long-term archive — a daily
            job removes anything older than the window.
          </p>
        </Section>

        {/* ─── Commitments ──────────────────────────────────────────────────── */}
        <Section title="Our commitments">
          <ul className="ml-4 list-disc space-y-2">
            <li>Your <span className="font-medium text-ink">raw IP address and user-agent are never stored</span> — only a one-way salted hash.</li>
            <li>The integrity log is <span className="font-medium text-ink">never used to judge the content of what you say</span>, and never to hide, delete, or down-rank a post on suspicion.</li>
            <li>It is <span className="font-medium text-ink">observe-only</span>: it produces a signal for <span className="font-medium text-ink">human review</span>, and no consequence follows automatically from it.</li>
            <li>Submitting an official public comment is always free and always unlimited — a constitutional right we never gate.</li>
          </ul>
        </Section>
      </div>

      <footer className="mt-12 border-t border-rule pt-6 text-xs text-ink-soft/70">
        <p>
          Questions about your data or this page?{" "}
          <a
            href="mailto:civitics.platform@gmail.com"
            className="text-accent underline-offset-2 hover:underline"
          >
            Contact us
          </a>{" "}
          and we&apos;ll help.
        </p>
      </footer>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 text-lg font-semibold text-ink">{title}</h2>
      <div className="text-sm leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}
