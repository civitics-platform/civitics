/**
 * Legistar Web API client.
 *
 * Wraps the public OData-style REST API at:
 *   https://webapi.legistar.com/v1/{Client}/{Endpoint}
 *
 * Features:
 *   - Automatic $top/$skip pagination (1 000 rows per page)
 *   - OData $filter support for delta fetches
 *   - 150ms inter-request delay (polite crawling)
 *   - One automatic retry with 30s backoff on transient errors
 */

import { sleep } from "../utils";

const BASE_URL  = "https://webapi.legistar.com/v1";
const PAGE_SIZE = 1000;

import type {
  LegistarBody,
  LegistarPerson,
  LegistarMatter,
  LegistarEvent,
  LegistarEventItem,
  LegistarVote,
  LegistarOfficeRecord,
} from "./types";

export class LegistarClient {
  constructor(private readonly clientName: string) {}

  // ── Public fetch methods ────────────────────────────────────────────────

  fetchBodies(): Promise<LegistarBody[]> {
    return this.fetchAll<LegistarBody>("Bodies");
  }

  fetchPersons(): Promise<LegistarPerson[]> {
    return this.fetchAll<LegistarPerson>("Persons");
  }

  /**
   * Fetch all OfficeRecords (person ↔ body membership rows with term dates).
   * The membership signal the pipeline uses to derive current council members
   * (FIX-471). Paginated like every other endpoint, so cities with >1000
   * historical memberships (none of the current pilot metros) page cleanly.
   */
  fetchOfficeRecords(): Promise<LegistarOfficeRecord[]> {
    return this.fetchAll<LegistarOfficeRecord>("OfficeRecords");
  }

  /**
   * Fetch all Matters, optionally filtered to rows modified since `since`.
   * @param since  ISO datetime string, e.g. "2024-01-01T00:00:00"
   */
  fetchMatters(since?: string): Promise<LegistarMatter[]> {
    const filter = since
      ? `MatterLastModifiedUtc ge datetime'${since}'`
      : undefined;
    return this.fetchAll<LegistarMatter>("Matters", filter);
  }

  /**
   * Fetch Events (meetings), optionally filtered by EventDate.
   * On first run, caller should pass a 90-day lookback to avoid pulling
   * a full decade of meeting history.
   */
  async fetchEvents(since?: string): Promise<LegistarEvent[]> {
    // Use date-only — some Legistar clients reject datetime literals with a time component.
    const dateOnly = since ? since.slice(0, 10) : undefined;
    const filter = dateOnly ? `EventDate ge datetime'${dateOnly}'` : undefined;
    try {
      return await this.fetchAll<LegistarEvent>("Events", filter);
    } catch (err) {
      // Some clients (e.g. sfgov) don't support EventDate OData filtering at all.
      // Fall back to fetching all events so we still get meetings data.
      if (filter && (err as Error).message?.includes("400")) {
        console.warn(`    Events: OData date filter not supported by ${this.clientName}, fetching all events`);
        return this.fetchAll<LegistarEvent>("Events");
      }
      throw err;
    }
  }

  /** Fetch all EventItems for a specific meeting. */
  fetchEventItems(eventId: number): Promise<LegistarEventItem[]> {
    return this.fetchAll<LegistarEventItem>("EventItems", `EventItemEventId eq ${eventId}`);
  }

  /** Fetch all Votes for a specific EventItem (agenda item with a roll call). */
  fetchVotes(eventItemId: number): Promise<LegistarVote[]> {
    return this.fetchAll<LegistarVote>(`EventItems/${eventItemId}/Votes`);
  }

  // ── Private pagination ──────────────────────────────────────────────────

  private async fetchAll<T>(
    endpoint: string,
    filter?: string,
  ): Promise<T[]> {
    const results: T[] = [];
    let skip = 0;
    let page = 0;

    while (true) {
      page++;
      const url = this.buildUrl(endpoint, skip, filter);

      let data: T[] | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            if (res.status === 404) {
              // Some endpoints return 404 when empty rather than []
              return results;
            }
            throw new Error(`HTTP ${res.status} — ${url}`);
          }
          data = (await res.json()) as T[];
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          console.warn(`    Legistar fetch failed (attempt ${attempt}): ${(err as Error).message} — retrying in 30s`);
          await sleep(30_000);
        }
      }

      if (!data || data.length === 0) break;
      results.push(...data);

      if (data.length < PAGE_SIZE) break; // last page
      skip += PAGE_SIZE;

      await sleep(150); // polite crawling
    }

    return results;
  }

  private buildUrl(endpoint: string, skip: number, filter?: string): string {
    const params = new URLSearchParams({
      $top:  String(PAGE_SIZE),
      $skip: String(skip),
    });
    if (filter) params.set("$filter", filter);
    return `${BASE_URL}/${this.clientName}/${endpoint}?${params}`;
  }
}
