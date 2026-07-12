import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { resolveEntityLabels } from "../../src/lib/entity-labels";
import { InboxModule, type InboxNotification } from "./components/InboxModule";
import { WatchingModule, type WatchingItem } from "./components/WatchingModule";
import { ReceiptsModule, type ReceiptItem } from "./components/ReceiptsModule";
import { PickUpModule, type ResumeInvestigation, type ResumeEvidenceCard } from "./components/PickUpModule";
import { VerificationModule, type VerifiedJurisdiction, type OfficialClaim } from "./components/VerificationModule";
import { PrioritiesModule } from "./components/PrioritiesModule";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your Desk" };

const RECEIPTS_LIMIT = 50;

export default async function DeskPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in?next=/desk");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;

  // withDbTimeout infers its generic T from the query builder; an `any`-typed
  // builder collapses T to `unknown`, so annotate the result shape explicitly.
  // Consumers cast `.data` downstream, so a permissive shape is sufficient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type DbRes = { data: any; error: any; count?: number | null };

  // ── Wave 1: identity + grants + the read-only module sources (parallel) ──────
  const [
    profileRes,
    prefsRes,
    grantsRes,
    notificationsRes,
    unreadRes,
    followsRes,
    receiptsRes,
    openInvestigationsRes,
    proposedCardsRes,
  ] = (await Promise.all([
    withDbTimeout(
      supabase
        .from("users")
        .select("id, display_name, email, civic_credits_balance, created_at")
        .eq("id", user.id)
        .maybeSingle(),
      3000,
      "desk:profile"
    ),
    withDbTimeout(
      sbAny
        .from("user_preferences")
        .select("home_state, home_district")
        .eq("user_id", user.id)
        .maybeSingle(),
      3000,
      "desk:prefs"
    ),
    withDbTimeout(
      sbAny
        .from("entity_grants")
        .select("id, role, target_type, target_id, status, granted_at, expires_at, created_at")
        .eq("user_id", user.id),
      3000,
      "desk:grants"
    ),
    withDbTimeout(
      sbAny
        .from("notifications")
        .select("id, title, body, link, is_read, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(30),
      3000,
      "desk:notifications"
    ),
    withDbTimeout(
      sbAny
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("is_read", false),
      3000,
      "desk:unread-count"
    ),
    withDbTimeout(
      sbAny
        .from("user_follows")
        .select("id, entity_type, entity_id, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      3000,
      "desk:follows"
    ),
    withDbTimeout(sbAny.rpc("get_user_receipts", { p_limit: RECEIPTS_LIMIT }), 3000, "desk:receipts"),
    withDbTimeout(
      sbAny
        .from("investigations")
        .select("id, title")
        .eq("created_by", user.id)
        .eq("status", "open")
        .order("updated_at", { ascending: false })
        .limit(10),
      3000,
      "desk:open-investigations"
    ),
    withDbTimeout(
      sbAny
        .from("evidence_cards")
        .select("id, investigation_id, claim_text, created_at")
        .eq("author_id", user.id)
        .eq("status", "proposed")
        .order("created_at", { ascending: false })
        .limit(15),
      3000,
      "desk:proposed-cards"
    ),
  ])) as [DbRes, DbRes, DbRes, DbRes, DbRes, DbRes, DbRes, DbRes, DbRes];

  // ── Identity ────────────────────────────────────────────────────────────────
  let profile = profileRes.data as
    | { id: string; display_name: string | null; email: string | null; civic_credits_balance: number | null; created_at: string | null }
    | null;
  if (!profile && user.email) {
    const { data: emailMatch } = await withDbTimeout(
      supabase
        .from("users")
        .select("id, display_name, email, civic_credits_balance, created_at")
        .eq("email", user.email)
        .maybeSingle(),
      3000,
      "desk:profile-by-email"
    );
    profile = emailMatch ?? null;
  }
  const displayName = profile?.display_name || user.email || "Anonymous";
  const memberSince = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long" })
    : null;

  const prefs = (prefsRes.data ?? null) as { home_state: string | null; home_district: number | null } | null;

  // ── Grants: derive constituent state, official claims, elevated-desk flag ─────
  type GrantRow = {
    id: string;
    role: string;
    target_type: string;
    target_id: string;
    status: string;
    granted_at: string | null;
    expires_at: string | null;
    created_at: string;
  };
  const grants = (grantsRes.data ?? []) as GrantRow[];

  const constituentGrants = grants.filter(
    (g) => g.role === "constituent" && g.target_type === "jurisdiction" && g.status === "active"
  );
  const earliestExpiry =
    constituentGrants
      .map((g) => g.expires_at)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;

  // Official claims — latest claim per official (every status), newest first.
  const officialGrantsSorted = grants
    .filter((g) => g.role === "official" && g.target_type === "official")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latestClaimByOfficial = new Map<string, GrantRow>();
  for (const g of officialGrantsSorted) {
    if (!latestClaimByOfficial.has(g.target_id)) latestClaimByOfficial.set(g.target_id, g);
  }
  const officialClaimRows = [...latestClaimByOfficial.values()];

  // The official/jurisdiction *desk* is a future workspace — show the placeholder
  // when the user actually holds such a grant (active), not merely a pending claim.
  const hasElevatedDesk = grants.some(
    (g) => (g.role === "official" || g.role === "jurisdiction") && g.status === "active"
  );

  // ── Module data ──────────────────────────────────────────────────────────────
  const notifications = (notificationsRes.data ?? []) as InboxNotification[];
  const unreadCount = (unreadRes.count as number | null) ?? 0;

  type FollowRow = { id: string; entity_type: string; entity_id: string };
  const follows = (followsRes.data ?? []) as FollowRow[];

  type RawReceipt = {
    action_type: string;
    entity_type: string;
    entity_id: string;
    ref_id: string | null;
    detail: Record<string, unknown> | null;
    created_at: string;
  };
  const receipts = (receiptsRes.data ?? []) as RawReceipt[];

  const openInvestigations = (openInvestigationsRes.data ?? []) as ResumeInvestigation[];
  type RawCard = { id: string; investigation_id: string; claim_text: string };
  const proposedCards = (proposedCardsRes.data ?? []) as RawCard[];

  // Investigation titles for the proposed-card list (open list already has titles).
  const cardInvIds = [...new Set(proposedCards.map((c) => c.investigation_id))];
  const invTitleById = new Map<string, string>(openInvestigations.map((i) => [i.id, i.title]));
  const missingInvIds = cardInvIds.filter((id) => !invTitleById.has(id));
  if (missingInvIds.length > 0) {
    const { data: invs } = (await withDbTimeout(
      sbAny.from("investigations").select("id, title").in("id", missingInvIds),
      3000,
      "desk:missing-inv-titles"
    )) as DbRes;
    for (const inv of (invs ?? []) as { id: string; title: string }[]) invTitleById.set(inv.id, inv.title);
  }
  const evidenceCards: ResumeEvidenceCard[] = proposedCards.map((c) => ({
    id: c.id,
    investigation_id: c.investigation_id,
    claim_text: c.claim_text,
    investigation_title: invTitleById.get(c.investigation_id) ?? null,
  }));

  // ── One batched label resolve across every surface that needs entity names ───
  const labels = await resolveEntityLabels(sbAny, [
    ...follows.map((f) => ({ entity_type: f.entity_type, entity_id: f.entity_id })),
    ...receipts.map((r) => ({ entity_type: r.entity_type, entity_id: r.entity_id })),
    ...constituentGrants.map((g) => ({ entity_type: "jurisdiction", entity_id: g.target_id })),
    ...officialClaimRows.map((g) => ({ entity_type: "official", entity_id: g.target_id })),
  ]);

  const watchingItems: WatchingItem[] = follows
    .filter((f): f is FollowRow & { entity_type: "official" | "agency" | "jurisdiction" } =>
      f.entity_type === "official" || f.entity_type === "agency" || f.entity_type === "jurisdiction"
    )
    .map((f) => {
      const resolved = labels.get(`${f.entity_type}:${f.entity_id}`);
      return {
        id: f.id,
        entity_type: f.entity_type,
        entity_id: f.entity_id,
        label: resolved?.label ?? "Unknown",
        href: resolved?.href ?? "#",
        chip: resolved?.chip ?? f.entity_type.toUpperCase(),
      };
    });

  const receiptItems: ReceiptItem[] = receipts.map((r) => {
    const resolved = labels.get(`${r.entity_type}:${r.entity_id}`);
    return {
      action_type: r.action_type,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      ref_id: r.ref_id,
      detail: r.detail,
      created_at: r.created_at,
      label: resolved?.label ?? null,
      href: resolved?.href ?? null,
      chip: resolved?.chip ?? null,
    };
  });

  const verifiedJurisdictions: VerifiedJurisdiction[] = constituentGrants.map((g) => ({
    id: g.id,
    name: labels.get(`jurisdiction:${g.target_id}`)?.label ?? "your jurisdiction",
  }));
  const officialClaims: OfficialClaim[] = officialClaimRows.map((g) => ({
    id: g.id,
    target_id: g.target_id,
    status: g.status,
    expires_at: g.expires_at,
    name: labels.get(`official:${g.target_id}`)?.label ?? "Unknown official",
  }));

  // ── Header counts ────────────────────────────────────────────────────────────
  const contributions = receipts.length >= RECEIPTS_LIMIT ? `${RECEIPTS_LIMIT}+` : `${receipts.length}`;
  const constituentLine =
    verifiedJurisdictions.length > 0
      ? `Constituent — ${verifiedJurisdictions.map((j) => j.name).join(", ")}`
      : prefs?.home_state
        ? `${prefs.home_state}${prefs.home_district ? `-${prefs.home_district}` : ""}`
        : null;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-paper">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="border-b border-rule pb-6">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            The Citizen Desk
          </p>
          <h1 className="mt-1.5 font-serif text-3xl font-bold text-ink">{displayName}</h1>
          {constituentLine && <p className="mt-1 text-sm text-ink-soft">{constituentLine}</p>}
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[12px] text-ink-soft">
            <div className="flex items-baseline gap-1.5">
              <dt>Contributions</dt>
              <dd className="font-semibold tabular-nums text-ink">{contributions}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt>Watching</dt>
              <dd className="font-semibold tabular-nums text-ink">{watchingItems.length}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt>Unread</dt>
              <dd className="font-semibold tabular-nums text-ink">{unreadCount}</dd>
            </div>
            {memberSince && (
              <div className="flex items-baseline gap-1.5">
                <dt>Member since</dt>
                <dd className="font-semibold text-ink">{memberSince}</dd>
              </div>
            )}
          </dl>
        </header>

        {/* Elevated-desk placeholder — official/jurisdiction desks are a later phase */}
        {hasElevatedDesk && (
          <div className="mt-6 border border-dashed border-rule bg-paper-2 px-5 py-4">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
              Official / Jurisdiction desk
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Your verified office workspace — responsiveness, comment-window publishing, and
              records management — is coming soon.
            </p>
          </div>
        )}

        {/* Modules */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <ReceiptsModule items={receiptItems} />
            <PickUpModule investigations={openInvestigations} evidenceCards={evidenceCards} />
          </div>
          <div className="space-y-6">
            <InboxModule initial={notifications} initialUnread={unreadCount} />
            <WatchingModule items={watchingItems} />
            {/* FIX-812 — My Priorities moved here from the /graph left panel */}
            <PrioritiesModule />
          </div>
        </div>

        {/* Verification spans full width */}
        <div className="mt-6">
          <VerificationModule
            verifiedJurisdictions={verifiedJurisdictions}
            earliestExpiry={earliestExpiry}
            officialClaims={officialClaims}
            initialState={prefs?.home_state ?? null}
            initialDistrict={prefs?.home_district ?? null}
          />
        </div>
      </div>
    </div>
  );
}
