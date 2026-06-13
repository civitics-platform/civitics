// FIX-559: /admin/grants — pending official-claim review queue + recent
// grant-events audit list. Gated on ADMIN_EMAIL OR an active platform_admin
// grant (decision 12); notFound() for everyone else so the route isn't
// discoverable, mirroring pipeline-health. Force-dynamic: gated on the
// signed-in user and createAdminClient() needs the secret key at request time.
export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { createAdminClient } from "@civitics/db";
import { PageHeader, SectionCard, SectionHeader } from "@civitics/ui";
import { requireGrantsAdmin } from "../../api/admin/grants/_lib";
import { GrantActions } from "./GrantActions";

export const metadata = { title: "Grant Review | Admin" };

type PendingClaim = {
  id: string;
  created_at: string;
  claimant_email: string | null;
  claimant_name: string | null;
  official_id: string | null;
  official_name: string | null;
  method: string | null;
  domain: string | null;
  domain_match: boolean;
  justification: string | null;
};

type EventRow = {
  id: number;
  event: string;
  occurred_at: string;
  actor_email: string | null;
  claimant_email: string | null;
  official_name: string | null;
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EVENT_STYLES: Record<string, string> = {
  submitted:     "bg-amber/20 text-ink",
  auto_approved: "bg-green-ink/10 text-green-ink",
  approved:      "bg-green-ink/10 text-green-ink",
  rejected:      "bg-accent/10 text-accent",
  expired:       "bg-ink/5 text-ink-soft",
};

export default async function AdminGrantsPage() {
  const adminId = await requireGrantsAdmin();
  if (!adminId) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Pending official claims (entity_grants_pending_idx covers the scan).
  const { data: pendingRaw } = await admin
    .from("entity_grants")
    .select("id, user_id, target_id, evidence_id, created_at")
    .eq("status", "pending")
    .eq("role", "official")
    .eq("target_type", "official")
    .order("created_at", { ascending: true })
    .limit(100);

  type PendingRow = {
    id: string;
    user_id: string;
    target_id: string | null;
    evidence_id: string | null;
    created_at: string;
  };
  const pendingRows: PendingRow[] = pendingRaw ?? [];

  // Recent audit trail across all grant kinds, newest first.
  const { data: eventsRaw } = await admin
    .from("grant_events")
    .select("id, grant_id, event, actor_id, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(25);

  type RawEvent = {
    id: number;
    grant_id: string;
    event: string;
    actor_id: string | null;
    occurred_at: string;
  };
  const eventRows: RawEvent[] = eventsRaw ?? [];

  // Bulk-hydrate users / officials / evidence for both lists.
  const eventGrantIds = [...new Set(eventRows.map((e) => e.grant_id))];
  const { data: eventGrantsRaw } = eventGrantIds.length
    ? await admin
        .from("entity_grants")
        .select("id, user_id, target_type, target_id")
        .in("id", eventGrantIds)
    : { data: [] };
  type GrantRef = { id: string; user_id: string; target_type: string; target_id: string | null };
  const grantById = new Map<string, GrantRef>(
    ((eventGrantsRaw ?? []) as GrantRef[]).map((g) => [g.id, g]),
  );

  const userIds = [
    ...new Set([
      ...pendingRows.map((g) => g.user_id),
      ...eventRows.map((e) => e.actor_id).filter(Boolean),
      ...[...grantById.values()].map((g) => g.user_id),
    ]),
  ] as string[];
  const officialIds = [
    ...new Set([
      ...pendingRows.map((g) => g.target_id).filter(Boolean),
      ...[...grantById.values()]
        .filter((g) => g.target_type === "official")
        .map((g) => g.target_id)
        .filter(Boolean),
    ]),
  ] as string[];
  const evidenceIds = [
    ...new Set(pendingRows.map((g) => g.evidence_id).filter(Boolean)),
  ] as string[];

  const [usersRes, officialsRes, evidenceRes] = await Promise.all([
    userIds.length
      ? admin.from("users").select("id, email, display_name").in("id", userIds)
      : Promise.resolve({ data: [] }),
    officialIds.length
      ? admin.from("officials").select("id, full_name").in("id", officialIds)
      : Promise.resolve({ data: [] }),
    evidenceIds.length
      ? admin
          .from("grant_evidence")
          .select("id, method, notes, metadata")
          .in("id", evidenceIds)
      : Promise.resolve({ data: [] }),
  ]);

  const userById = new Map<string, { email: string | null; display_name: string | null }>(
    ((usersRes.data ?? []) as Array<{ id: string; email: string | null; display_name: string | null }>).map(
      (u) => [u.id, { email: u.email, display_name: u.display_name }],
    ),
  );
  const officialById = new Map<string, string>(
    ((officialsRes.data ?? []) as Array<{ id: string; full_name: string }>).map((o) => [
      o.id,
      o.full_name,
    ]),
  );
  const evidenceById = new Map<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { method: string | null; notes: string | null; metadata: any }
  >(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((evidenceRes.data ?? []) as any[]).map((e) => [
      e.id,
      { method: e.method, notes: e.notes, metadata: e.metadata },
    ]),
  );

  const claims: PendingClaim[] = pendingRows.map((g) => {
    const claimant = userById.get(g.user_id);
    const evidence = g.evidence_id ? evidenceById.get(g.evidence_id) : undefined;
    return {
      id: g.id,
      created_at: g.created_at,
      claimant_email: claimant?.email ?? null,
      claimant_name: claimant?.display_name ?? null,
      official_id: g.target_id,
      official_name: g.target_id ? officialById.get(g.target_id) ?? null : null,
      method: evidence?.method ?? null,
      domain: evidence?.metadata?.auth_email_domain ?? null,
      domain_match: evidence?.metadata?.domain_match === true,
      justification: evidence?.notes ?? null,
    };
  });

  const events: EventRow[] = eventRows.map((e) => {
    const grant = grantById.get(e.grant_id);
    const claimant = grant ? userById.get(grant.user_id) : undefined;
    const actor = e.actor_id ? userById.get(e.actor_id) : undefined;
    return {
      id: e.id,
      event: e.event,
      occurred_at: e.occurred_at,
      actor_email: actor?.email ?? null,
      claimant_email: claimant?.email ?? null,
      official_name:
        grant?.target_type === "official" && grant.target_id
          ? officialById.get(grant.target_id) ?? null
          : null,
    };
  });

  return (
    <div className="min-h-screen bg-paper">
      <main id="main-content">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <PageHeader
            title="Grant Review"
            description="Pending official profile claims awaiting review, plus the recent grant audit trail."
            breadcrumb={[
              { label: "Civitics", href: "/" },
              { label: "Admin" },
              { label: "Grants" },
            ]}
          />

          <SectionCard noPadding>
            <div className="p-6 border-b-2 border-ink">
              <SectionHeader
                title={`Pending claims (${claims.length})`}
                description="Exact auth-email matches auto-approve and never appear here. Everything below needs a human call — the domain-match flag means the claimant's email domain matches the official's listed email domain."
              />
            </div>

            {claims.length === 0 ? (
              <div className="p-8 text-center text-sm text-ink-soft">
                No pending claims. New submissions land here when an official
                claims their profile without an exact email match.
              </div>
            ) : (
              <div className="divide-y divide-rule">
                {claims.map((c) => (
                  <div key={c.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {c.claimant_name || c.claimant_email || "Unknown user"}
                        </span>
                        {c.claimant_name && c.claimant_email && (
                          <span className="text-xs text-ink-soft">{c.claimant_email}</span>
                        )}
                        <span className="border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                          {c.method ?? "—"}
                        </span>
                        {c.domain && (
                          <span className="bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                            @{c.domain}
                          </span>
                        )}
                        {c.domain_match && (
                          <span className="rounded-full bg-civic-blue/10 px-2 py-0.5 text-[10px] font-medium text-civic-blue">
                            domain match
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-soft">
                        Claiming{" "}
                        {c.official_id ? (
                          <a
                            href={`/officials/${c.official_id}`}
                            className="font-medium text-accent hover:underline"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {c.official_name ?? "Unknown official"}
                          </a>
                        ) : (
                          <span className="font-medium">{c.official_name ?? "Unknown official"}</span>
                        )}{" "}
                        · submitted {formatWhen(c.created_at)}
                      </p>
                      {c.justification && (
                        <p className="mt-2 border border-rule bg-paper-2 px-3 py-2 text-xs leading-relaxed text-ink whitespace-pre-wrap">
                          {c.justification}
                        </p>
                      )}
                    </div>
                    <GrantActions grantId={c.id} />
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="mt-6">
            <SectionCard noPadding>
              <div className="p-6 border-b-2 border-ink">
                <SectionHeader
                  title="Recent grant events"
                  description="Append-only audit trail across all grant types, newest first."
                />
              </div>
              {events.length === 0 ? (
                <div className="p-8 text-center text-sm text-ink-soft">No grant events yet.</div>
              ) : (
                <div className="divide-y divide-rule">
                  {events.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                      <span
                        className={`shrink-0 px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                          EVENT_STYLES[e.event] ?? "bg-ink/5 text-ink-soft"
                        }`}
                      >
                        {e.event}
                      </span>
                      <p className="flex-1 truncate text-xs text-ink">
                        {e.claimant_email ?? "unknown user"}
                        {e.official_name ? ` → ${e.official_name}` : ""}
                        {e.actor_email && e.actor_email !== e.claimant_email
                          ? ` (by ${e.actor_email})`
                          : ""}
                      </p>
                      <p className="shrink-0 font-mono text-[10px] text-ink-soft/70 tabular-nums">
                        {formatWhen(e.occurred_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      </main>
    </div>
  );
}
