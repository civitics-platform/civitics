import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type DonorType = Database["public"]["Tables"]["financial_relationships"]["Row"]["donor_type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["financial_relationships"]["Row"];

/** All donations to a specific official, largest first. */
export async function listDonationsByOfficial(
  db: DB,
  officialId: string,
  cycleYear?: number,
  limit = 100
): Promise<Row[]> {
  let query = db
    .from("financial_relationships")
    .select("*")
    .eq("official_id", officialId)
    .order("amount_cents", { ascending: false })
    .limit(limit);

  if (cycleYear !== undefined) {
    query = query.eq("cycle_year", cycleYear);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Top donors to an official.
 * Groups by donor_name and sums amount_cents.
 * Supabase doesn't support GROUP BY directly; we aggregate in JS for now.
 * Replace with a Postgres function or view in Phase 3+.
 */
export async function getTopDonorsByOfficial(
  db: DB,
  officialId: string,
  cycleYear?: number,
  topN = 20
): Promise<{ donor_name: string; donor_type: DonorType; total_cents: number }[]> {
  const rows = await listDonationsByOfficial(db, officialId, cycleYear, 1000);

  const map = new Map<string, { donor_type: DonorType; total_cents: number }>();
  for (const row of rows) {
    const existing = map.get(row.donor_name);
    if (existing) {
      existing.total_cents += row.amount_cents;
    } else {
      map.set(row.donor_name, {
        donor_type: row.donor_type,
        total_cents: row.amount_cents,
      });
    }
  }

  return Array.from(map.entries())
    .map(([donor_name, v]) => ({ donor_name, ...v }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, topN);
}

/** Donations from a specific donor name (for cross-official correlation). */
export async function listDonationsByDonor(
  db: DB,
  donorName: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("financial_relationships")
    .select("*")
    .ilike("donor_name", `%${donorName}%`)
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return data;
}

/** Donation totals by industry for an official — for the donor-vote analyzer. */
export async function getDonationsByIndustry(
  db: DB,
  officialId: string,
  cycleYear?: number
): Promise<{ industry: string; total_cents: number }[]> {
  const rows = await listDonationsByOfficial(db, officialId, cycleYear, 5000);

  const map = new Map<string, number>();
  for (const row of rows) {
    const key = row.industry ?? "Unknown";
    map.set(key, (map.get(key) ?? 0) + row.amount_cents);
  }

  return Array.from(map.entries())
    .map(([industry, total_cents]) => ({ industry, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents);
}
