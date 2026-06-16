import { redirect } from "next/navigation";

// FIX-598 (Commons/Desk MVP PR2): /profile is subsumed by the Citizen Desk.
// The page body now permanently redirects to /desk. DistrictPickerForm and
// VerifyConstituentForm stay in this directory — they're imported by the Desk's
// Verification module (and jurisdictions/[id] VerifyConstituentSection).
export const dynamic = "force-dynamic";

export default function ProfilePage() {
  redirect("/desk");
}
