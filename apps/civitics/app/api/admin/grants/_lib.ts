import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

// FIX-559 decision 12: /admin/grants and its action routes admit a user when
// their email matches ADMIN_EMAIL **or** they hold an active global
// platform_admin grant (has_active_platform_admin_grant, FIX-557). The env
// check is belt-and-braces during beta; the grant path is what scales past a
// single admin. Shared by the page (notFound() on null) and the action route
// (403 on null).
export async function requireGrantsAdmin(): Promise<string | null> {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const adminEmail = process.env["ADMIN_EMAIL"];
  if (adminEmail && user.email === adminEmail) return user.id;

  const { data: isAdmin } = await supabase.rpc("has_active_platform_admin_grant", {
    p_user_id: user.id,
  });
  return isAdmin === true ? user.id : null;
}
