import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@civitics/db";
import { DistrictPickerForm } from "./DistrictPickerForm";
import { VerifyConstituentForm } from "./VerifyConstituentForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your Profile" };

export default async function ProfilePage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in?next=/profile");
  }

  // Look up users row — migration 0009 uses id = auth.users(id) directly
  const { data: profile } = await supabase
    .from("users")
    .select("id, display_name, email, avatar_url, civic_credits_balance, is_active, created_at")
    .eq("id", user.id)
    .maybeSingle();

  // Fetch user's saved district preferences for the picker's initial values
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prefs } = await (supabase as any)
    .from("user_preferences")
    .select("home_state, home_district")
    .eq("user_id", user.id)
    .maybeSingle();

  // Active constituent grants — drives the verify form vs. verified card render.
  // RLS users_read_own_grants restricts this to the signed-in user's rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activeGrants } = await (supabase as any)
    .from("entity_grants")
    .select("id, target_id, expires_at")
    .eq("user_id", user.id)
    .eq("role", "constituent")
    .eq("target_type", "jurisdiction")
    .eq("status", "active");

  type GrantRow = { id: string; target_id: string; expires_at: string | null };
  const grants: GrantRow[] = activeGrants ?? [];

  let verifiedJurisdictions: Array<{ id: string; name: string; type: string }> = [];
  let earliestExpiry: string | null = null;
  if (grants.length > 0) {
    const ids = grants.map((g) => g.target_id);
    const { data: jurs } = await supabase
      .from("jurisdictions")
      .select("id, name, type")
      .in("id", ids);
    verifiedJurisdictions = (jurs ?? []) as Array<{
      id: string;
      name: string;
      type: string;
    }>;
    earliestExpiry = grants
      .map((g) => g.expires_at)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;
  }

  // Fallback to email-based lookup if no row exists yet (first sign-in edge case)
  let resolvedProfile = profile;
  if (!resolvedProfile && user.email) {
    const { data: emailMatch } = await supabase
      .from("users")
      .select("id, display_name, email, avatar_url, civic_credits_balance, is_active, created_at")
      .eq("email", user.email)
      .maybeSingle();
    resolvedProfile = emailMatch;
  }

  const displayName = resolvedProfile?.display_name || user.email || "Anonymous";
  const email = resolvedProfile?.email || user.email;
  const civicCredits = resolvedProfile?.civic_credits_balance ?? 0;
  const memberSince = resolvedProfile?.created_at
    ? new Date(resolvedProfile.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
      })
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Your Profile</h1>

      {/* Profile card */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        {/* Avatar + name */}
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-lg font-bold text-indigo-700">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{displayName}</h2>
            {memberSince && (
              <p className="text-sm text-gray-500">Member since {memberSince}</p>
            )}
          </div>
        </div>

        {/* Details grid */}
        <dl className="divide-y divide-gray-100">
          {/* Email */}
          <div className="flex items-center justify-between py-3">
            <div>
              <dt className="text-sm font-medium text-gray-500">Email</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{email || "Not available"}</dd>
            </div>
          </div>

          {/* Civic credits */}
          <div className="flex items-center justify-between py-3">
            <div>
              <dt className="text-sm font-medium text-gray-500">Civic Credits</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{civicCredits} civic credits</dd>
            </div>
          </div>
        </dl>
      </div>

      {/* Constituent verification — form when no active grants, card when verified */}
      {verifiedJurisdictions.length > 0 ? (
        <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-6 shadow-sm">
          <h3 className="text-base font-semibold text-green-900">Verified constituent</h3>
          <p className="mt-1 text-sm text-green-800">
            Verified constituent of {verifiedJurisdictions.map((j) => j.name).join(", ")}.
            {earliestExpiry && (
              <>
                {" "}
                Expires {new Date(earliestExpiry).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}.
              </>
            )}
          </p>
        </div>
      ) : (
        <VerifyConstituentForm />
      )}

      {/* District picker — sets home_state/home_district for the USER graph node */}
      <DistrictPickerForm
        initialState={prefs?.home_state ?? null}
        initialDistrict={prefs?.home_district ?? null}
      />

      {/* Coming soon sections */}
      <div className="mt-6 space-y-4">
        {/* Saved officials */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 shadow-sm opacity-60">
          <h3 className="text-sm font-semibold text-gray-700">Saved Officials</h3>
          <p className="mt-1 text-sm text-gray-400">Coming soon — follow officials to track their activity.</p>
        </div>

        {/* Comment history */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 shadow-sm opacity-60">
          <h3 className="text-sm font-semibold text-gray-700">Comment History</h3>
          <p className="mt-1 text-sm text-gray-400">Coming soon — view your past comments and positions.</p>
        </div>
      </div>
    </div>
    </div>
  );
}
