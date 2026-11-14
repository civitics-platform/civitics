/**
 * FIX-253 · SEC EDGAR pipeline orchestrator.
 *
 * Two entry points:
 *
 *   runEdgarPipeline()        — weekly full reconciliation of the tracked
 *                                universe (S&P 500). Refreshes company
 *                                metadata, parses each company's most-recent
 *                                DEF 14A, runs the donor-match pass, writes
 *                                external_relationships edges and review
 *                                queue rows. Targeted by `pnpm data:edgar`.
 *
 *   runEdgarDailyPipeline()   — reads the newest file the SEC daily-index
 *                                quarter listing names, for SCHEDULE 13D/G
 *                                (and the older SC 13D/G) filings touching
 *                                tracked CIKs. DRY by default — see
 *                                EDGAR_DAILY_WRITES. Targeted by
 *                                `pnpm data:edgar:daily`.
 *
 * Both pipelines call sync-log per audit §1b. Neither calls
 * rebuild_entity_connections() — the nightly orchestrator does that
 * authoritatively after every pipeline.
 *
 * Env overrides:
 *   EDGAR_CIKS=320193,1018724,...    Smoke-test a small subset of CIKs.
 *   EDGAR_DAILY_DATE=YYYY-MM-DD      Read that day's index file instead of the
 *                                    newest listed one.
 */

import { canonicalizeEntityName } from "../fec-bulk/writer";
import {
  startSync,
  completeSync,
  failSync,
  skipSync,
  type PipelineResult,
} from "../sync-log";
import { syncCompanies } from "./companies";
import { parseDef14a } from "./def14a";
import { matchPersonToDonor } from "./matcher";
import {
  scanDailyShareholders,
  type DailyIndexOutcome,
  type ScanOptions,
  type ScanStats,
  type ShareholderFiling,
} from "./shareholders";
import { loadSp500Universe, type UniverseEntry } from "./universe";
import { padCik } from "./util";
import {
  setOfficerMatch,
  setShareholderMatch,
  upsertEdgarEdges,
  upsertEdgarReviewQueue,
  upsertOfficers,
  upsertShareholders,
  type EdgeInput,
  type OfficerWriteInput,
  type ReviewQueueInput,
  type ShareholderWriteInput,
} from "./writer";

// .in() id-list ceiling — the ~500-CIK S&P universe overflows the
// Kong/PostgREST URL budget above ~200 ids (FIX-545).
const EDGAR_IN_CHUNK = 200;

function selectUniverse(): ReturnType<typeof loadSp500Universe> {
  const all = loadSp500Universe();
  const filter = (process.env["EDGAR_CIKS"] ?? "").trim();
  if (!filter) return all;
  const wanted = new Set(filter.split(",").map((s) => padCik(s.trim())).filter(Boolean));
  const scoped = all.filter((u) => wanted.has(u.cik));
  console.info(`  [edgar] EDGAR_CIKS scope: ${scoped.length} / ${all.length} companies`);
  return scoped;
}

/** EDGAR_DAILY_DATE names the index file to read; unset, the run reads the newest listed. */
function dailyDateOverride(): Date | undefined {
  const override = process.env["EDGAR_DAILY_DATE"];
  if (override) {
    const d = new Date(`${override}T00:00:00Z`);
    if (Number.isFinite(d.getTime())) return d;
  }
  return undefined;
}

/**
 * FIX-1410 (cc-278 D4) — the 13D/G scanner runs DRY. It has never read an
 * index on prod (full-index URL, today's file, pre-2025 form names), so what
 * it does next — fetch each filing, parse a cover page written for the old
 * HTML form, write shareholders rows, match donors, queue org holders — has
 * never run there either. With this false the run does everything up to the
 * writes and stops: no shareholders row, no edge, no review-queue row, no
 * pipeline_state key. It logs `complete` with the parse yield in metadata.
 * Flipping it is a later prompt, after three nights of those rows are read.
 */
export const EDGAR_DAILY_WRITES = false;

/** Dry mode fetches at most this many tracked filings (2 GETs each, at the client's 10/s). */
export const DRY_RUN_FETCH_CAP = 200;

// ──────────────────────────────────────────────────────────────────────────
// Weekly pipeline
// ──────────────────────────────────────────────────────────────────────────

export async function runEdgarPipeline(): Promise<PipelineResult> {
  const logId = await startSync("edgar");
  const tStart = Date.now();
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    const universe = selectUniverse();
    console.info(`  [edgar] starting weekly run · ${universe.length} companies`);

    const companies = await syncCompanies(universe);
    if (companies.length === 0) {
      console.warn(`  [edgar] no companies synced — skipping`);
      await skipSync(logId, "no_companies");
      return result;
    }

    let officerInserts = 0;
    let edgeInserts    = 0;
    let queueInserts   = 0;
    let unparseable    = 0;

    for (const company of companies) {
      const parsed = await parseDef14a(company);
      if (parsed.unparseable) {
        unparseable++;
        continue;
      }
      if (parsed.officers.length === 0) continue;

      const officerInputs: OfficerWriteInput[] = parsed.officers.map((o) => ({
        companyId: company.edgarCompanyId,
        officer:   o,
      }));
      const { upserted, idMap, failed } = await upsertOfficers(officerInputs);
      officerInserts += upserted;
      result.failed  += failed;

      const companyCanonical = canonicalizeEntityName(company.universe.name);

      const edgesToAdd: EdgeInput[] = [];
      const reviewToAdd: ReviewQueueInput[] = [];

      for (const officer of parsed.officers) {
        const key = `${company.edgarCompanyId}|${officer.canonicalName}|${officer.effectiveYear}|${officer.roleCategory}`;
        const officerId = idMap.get(key);
        if (!officerId) continue;

        const outcome = await matchPersonToDonor(officer.canonicalName, companyCanonical);
        if (outcome.kind === "exact") {
          edgesToAdd.push({
            source_id:         `officer:${officerId}`,
            source_url:        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.universe.cik}`,
            from_entity_id:    outcome.donor.id,
            to_entity_id:      company.financialEntityId,
            connection_type:   "appointment",
            raw_category:      "def14a_officer",
            raw_category_name: officer.title || officer.roleCategory,
            description:       `${officer.roleCategory} of ${company.universe.name}`,
            amount_cents:      officer.totalCompensationCents,
            occurred_at:       null,
            ended_at:          null,
            is_current:        true,
            match_confidence:  "high",
            metadata: {
              accession:      officer.sourceAccession,
              role_category:  officer.roleCategory,
              effective_year: officer.effectiveYear,
            },
          });
          // Mark on the officer row too, so future runs short-circuit.
          await setOfficerMatch(officerId, outcome.donor.id, "high");
        } else if (outcome.kind === "name_only") {
          reviewToAdd.push({
            source_entity_id:  `officer:${officerId}`,
            source_payload: {
              officer_id:     officerId,
              full_name:      officer.fullName,
              company_id:     company.edgarCompanyId,
              company_name:   company.universe.name,
              title:          officer.title,
              accession:      officer.sourceAccession,
              effective_year: officer.effectiveYear,
            },
            candidate_matches: outcome.candidates.map((c) => ({
              civitics_id:   c.id,
              civitics_type: "financial_entity",
              score:         0.5,
              reason:        "name_match_no_employer",
              display_name:  c.displayName,
              employer:      c.employerRaw,
            })),
            reason: "name_match_no_employer",
          });
        } else if (outcome.kind === "too_many") {
          reviewToAdd.push({
            source_entity_id:  `officer:${officerId}`,
            source_payload: {
              officer_id:     officerId,
              full_name:      officer.fullName,
              company_id:     company.edgarCompanyId,
              company_name:   company.universe.name,
              title:          officer.title,
              accession:      officer.sourceAccession,
            },
            candidate_matches: [],
            reason: "too_many_lastname_hits",
          });
        }
        // outcome.kind === "none" → no donor row exists for this exec yet.
      }

      if (edgesToAdd.length > 0) {
        const e = await upsertEdgarEdges(edgesToAdd);
        edgeInserts += e.upserted;
        result.failed += e.failed;
      }
      if (reviewToAdd.length > 0) {
        const q = await upsertEdgarReviewQueue(reviewToAdd);
        queueInserts += q.upserted;
        result.failed += q.failed;
      }
    }

    console.info(`  [edgar] weekly run summary:`);
    console.info(`    officers upserted:    ${officerInserts}`);
    console.info(`    matched edges:        ${edgeInserts}`);
    console.info(`    review-queue entries: ${queueInserts}`);
    console.info(`    unparseable filings:  ${unparseable}`);
    console.info(`    duration:             ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

    result.inserted = officerInserts + edgeInserts + queueInserts;
    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [edgar] weekly run failed: ${msg}`);
    await failSync(logId, msg);
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Daily pipeline (13D/G poll)
// ──────────────────────────────────────────────────────────────────────────

/** What the daily's write half did. */
export interface DailyWriteCounts {
  shareholders: number;
  edges:        number;
  reviewQueue:  number;
  failed:       number;
}

/**
 * The daily run's collaborators — injectable so a test drives every index
 * outcome with a stubbed fetch and no database (FIX-1394). The nightly and the
 * CLI pass nothing and get these defaults.
 */
export interface EdgarDailyDeps {
  startSync:       typeof startSync;
  completeSync:    typeof completeSync;
  failSync:        typeof failSync;
  skipSync:        typeof skipSync;
  universe:        () => UniverseEntry[];
  loadTrackedCiks: (universe: UniverseEntry[]) => Promise<Map<string, string>>;
  scan:            (opts: ScanOptions) => Promise<DailyIndexOutcome>;
  writeFilings:    (filings: ShareholderFiling[], universe: UniverseEntry[]) => Promise<DailyWriteCounts>;
  now:             () => Date;
  dateOverride:    () => Date | undefined;
  writesEnabled:   boolean;
}

/** The parse yield, as data_sync_log.metadata carries it (cc-278 D4). */
function statsMetadata(file: string, stats: ScanStats, dryRun: boolean): Record<string, unknown> {
  return {
    dry_run:           dryRun,
    index_file:        file,
    rows_13dg:         stats.rows13dg,
    rows_13dg_by_form: stats.rows13dgByForm,
    rows_tracked:      stats.rowsTracked,
    filings_fetched:   stats.filingsFetched,
    not_fetched:       stats.notFetched,
    documents_found:   stats.documentsFound,
    fetch_errors:      stats.fetchErrors,
    holders_parsed:    stats.holdersParsed,
    holders_with_pct:  stats.holdersWithPct,
    unparsed:          stats.unparsed,
    samples:           stats.samples,
  };
}

// We need edgar_companies.id keyed by CIK. Don't refresh metadata daily — just
// bind CIK → company_id from edgar_companies.
async function loadTrackedCiksFromDb(universe: UniverseEntry[]): Promise<Map<string, string>> {
  const trackedCiks = new Map<string, string>();
  const { createAdminClient, rowsOrThrow } = await import("@civitics/db");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  // FIX-545: silent-zero here mis-skipped the day as "no tracked CIKs" on
  // a gateway blip; the ~500-CIK universe also overflows the ~200-id .in()
  // URL cap. Chunk + throw.
  for (let i = 0; i < universe.length; i += EDGAR_IN_CHUNK) {
    const rows = rowsOrThrow(
      await db
        .from("edgar_companies")
        .select("id, cik, financial_entity_id")
        .in("cik", universe.slice(i, i + EDGAR_IN_CHUNK).map((u) => u.cik)),
      "edgar daily tracked-CIK preload",
    ) as Array<{ id: string; cik: string; financial_entity_id: string | null }>;
    for (const r of rows) {
      if (r.financial_entity_id) trackedCiks.set(r.cik, r.id);
    }
  }
  return trackedCiks;
}

export async function runEdgarDailyPipeline(overrides: Partial<EdgarDailyDeps> = {}): Promise<PipelineResult> {
  const deps: EdgarDailyDeps = {
    startSync,
    completeSync,
    failSync,
    skipSync,
    universe:        selectUniverse,
    loadTrackedCiks: loadTrackedCiksFromDb,
    scan:            scanDailyShareholders,
    writeFilings:    writeDailyFilings,
    now:             () => new Date(),
    dateOverride:    dailyDateOverride,
    writesEnabled:   EDGAR_DAILY_WRITES,
    ...overrides,
  };
  const logId = await deps.startSync("edgar_daily");
  const tStart = Date.now();
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    const universe = deps.universe();
    const trackedCiks = await deps.loadTrackedCiks(universe);
    if (trackedCiks.size === 0) {
      console.warn(`  [edgar:daily] no tracked CIKs in edgar_companies — run weekly first`);
      await deps.skipSync(logId, "no_tracked_ciks");
      return result;
    }

    const outcome = await deps.scan({
      now:        deps.now(),
      date:       deps.dateOverride(),
      trackedCiks,
      maxFilings: deps.writesEnabled ? undefined : DRY_RUN_FETCH_CAP,
    });
    // FIX-1394: three answers, three statuses. A refused index used to come
    // back as an empty list and log `skipped / no_filings` — 180 nights of it.
    if (outcome.kind === "refused") {
      const msg = `daily index refused: HTTP ${outcome.status ?? "—"} ${outcome.url} — ${outcome.bodyHead}`;
      console.warn(`  [edgar:daily] ${msg}`);
      await deps.failSync(logId, msg, { index_url: outcome.url, index_http_status: outcome.status });
      result.fatal_error = msg;
      return result;
    }
    if (outcome.kind === "not_published") {
      console.info(`  [edgar:daily] ${outcome.file ?? "no master.*.idx"} is not in the listing yet — skipping`);
      await deps.skipSync(logId, "index_not_published", { index_file: outcome.file });
      return result;
    }
    if (outcome.stats.rowsTracked === 0) {
      console.info(`  [edgar:daily] no 13D/G filings for tracked CIKs in ${outcome.file} (${outcome.stats.rows13dg} 13D/G rows in the file)`);
      await deps.skipSync(logId, "no_filings", {
        index_file:        outcome.file,
        rows_13dg:         outcome.stats.rows13dg,
        rows_13dg_by_form: outcome.stats.rows13dgByForm,
      });
      return result;
    }

    const s = outcome.stats;
    if (!deps.writesEnabled) {
      console.info(`  [edgar:daily] DRY RUN (EDGAR_DAILY_WRITES=false) — nothing written:`);
      console.info(`    index file:           ${outcome.file}`);
      console.info(`    13D/G rows:           ${s.rows13dg} (${s.rowsTracked} on tracked CIKs)`);
      console.info(`    filings fetched:      ${s.filingsFetched} (${s.notFetched} past the cap of ${DRY_RUN_FETCH_CAP})`);
      console.info(`    documents found:      ${s.documentsFound} (${s.fetchErrors} fetch errors)`);
      console.info(`    holders parsed:       ${s.holdersParsed} (${s.holdersWithPct} with a percent; ${s.unparsed} filings unparsed)`);
      for (const x of s.samples) {
        console.info(`    sample:               ${x.accession} ${x.form} ${JSON.stringify(x.holder)} ${x.pct ?? "—"}%`);
      }
      console.info(`    duration:             ${((Date.now() - tStart) / 1000).toFixed(1)}s`);
      result.metadata = statsMetadata(outcome.file, s, true);
      await deps.completeSync(logId, result);
      return result;
    }

    const counts = await deps.writeFilings(outcome.filings, universe);
    result.failed += counts.failed;

    console.info(`  [edgar:daily] summary:`);
    console.info(`    index file:           ${outcome.file}`);
    console.info(`    filings:              ${outcome.filings.length}`);
    console.info(`    shareholders rows:    ${counts.shareholders}`);
    console.info(`    matched edges:        ${counts.edges}`);
    console.info(`    review-queue entries: ${counts.reviewQueue}`);
    console.info(`    duration:             ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

    result.inserted = counts.shareholders + counts.edges + counts.reviewQueue;
    result.metadata = statsMetadata(outcome.file, s, false);
    await deps.completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [edgar:daily] failed: ${msg}`);
    await deps.failSync(logId, msg);
    throw err;
  }
}

/**
 * The daily's write half: shareholders rows, the donor match, edges, and the
 * review queue. Only ever reached with a read index file.
 */
async function writeDailyFilings(
  filings: ShareholderFiling[],
  universe: UniverseEntry[],
): Promise<DailyWriteCounts> {
  const counts: DailyWriteCounts = { shareholders: 0, edges: 0, reviewQueue: 0, failed: 0 };
  // Bulk write all shareholders.
  const shareholderInputs: ShareholderWriteInput[] = [];
  for (const filing of filings) {
    for (const holder of filing.holders) {
      shareholderInputs.push({
        companyId: filing.companyId,
        holder,
        filing,
      });
    }
  }
  const { upserted: shInserted, idMap: shIds, failed: shFailed } = await upsertShareholders(shareholderInputs);
  counts.shareholders = shInserted;
  counts.failed += shFailed;

  // Build CIK → companyCanonical lookup for matching.
  const cikToCanonical = new Map<string, string>();
  for (const u of universe) cikToCanonical.set(u.cik, canonicalizeEntityName(u.name));

  // Build CIK → company financial_entity_id lookup.
  const cikToFinancialEntity = new Map<string, string>();
  {
    const { createAdminClient, rowsOrThrow } = await import("@civitics/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    // FIX-545: same chunk + throw as the tracked-CIK preload above.
    for (let i = 0; i < universe.length; i += EDGAR_IN_CHUNK) {
      const rows = rowsOrThrow(
        await db
          .from("edgar_companies")
          .select("cik, financial_entity_id")
          .in("cik", universe.slice(i, i + EDGAR_IN_CHUNK).map((u) => u.cik)),
        "edgar daily financial-entity preload",
      ) as Array<{ cik: string; financial_entity_id: string | null }>;
      for (const row of rows) {
        if (row.financial_entity_id) cikToFinancialEntity.set(row.cik, row.financial_entity_id);
      }
    }
  }

  const edgesToAdd: EdgeInput[] = [];
  const reviewToAdd: ReviewQueueInput[] = [];

  for (const filing of filings) {
    const companyCanonical = cikToCanonical.get(filing.cik) ?? "";
    const companyEntityId = cikToFinancialEntity.get(filing.cik) ?? "";
    if (!companyEntityId) continue;

    for (const holder of filing.holders) {
      const sid = shIds.get(`${filing.accession}|${holder.canonicalHolderName}`);
      if (!sid) continue;

      if (holder.isOrganization) {
        // V1: org holders go to the review queue. Auto-binding org names to
        // existing financial_entities (or inserting new corp rows) is a
        // follow-up FIX.
        reviewToAdd.push({
          source_entity_id: `shareholder:${sid}`,
          source_payload: {
            shareholder_id: sid,
            holder_name:    holder.holderName,
            company_id:     filing.companyId,
            company_cik:    filing.cik,
            filing_type:    filing.filingType,
            accession:      filing.accession,
            pct_of_class:   holder.pctOfClass,
            shares_held:    holder.sharesHeld,
          },
          candidate_matches: [],
          reason: "org_holder_unmatched",
        });
        continue;
      }

      const outcome = await matchPersonToDonor(holder.canonicalHolderName, companyCanonical);
      if (outcome.kind === "exact") {
        edgesToAdd.push({
          source_id:         `shareholder:${sid}`,
          source_url:        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${filing.cik}`,
          from_entity_id:    outcome.donor.id,
          to_entity_id:      companyEntityId,
          connection_type:   "owns",
          raw_category:      filing.filingType.toLowerCase().replace(/\s+/g, "_"),
          raw_category_name: filing.filingType,
          description:       `${holder.pctOfClass ?? "?"}% of ${filing.cik}`,
          amount_cents:      null,
          occurred_at:       holder.eventDate ?? filing.filedAt,
          ended_at:          null,
          is_current:        true,
          match_confidence:  "high",
          metadata: {
            accession:    filing.accession,
            pct_of_class: holder.pctOfClass,
            shares_held:  holder.sharesHeld,
            filing_type:  filing.filingType,
          },
        });
        await setShareholderMatch(sid, outcome.donor.id, "high");
      } else if (outcome.kind === "name_only") {
        reviewToAdd.push({
          source_entity_id: `shareholder:${sid}`,
          source_payload: {
            shareholder_id: sid,
            holder_name:    holder.holderName,
            company_id:     filing.companyId,
            company_cik:    filing.cik,
            filing_type:    filing.filingType,
            accession:      filing.accession,
          },
          candidate_matches: outcome.candidates.map((c) => ({
            civitics_id:   c.id,
            civitics_type: "financial_entity",
            score:         0.5,
            reason:        "name_match_no_employer",
            display_name:  c.displayName,
            employer:      c.employerRaw,
          })),
          reason: "name_match_no_employer",
        });
      }
    }
  }

  if (edgesToAdd.length > 0) {
    const e = await upsertEdgarEdges(edgesToAdd);
    counts.edges = e.upserted;
    counts.failed += e.failed;
  }
  if (reviewToAdd.length > 0) {
    const q = await upsertEdgarReviewQueue(reviewToAdd);
    counts.reviewQueue = q.upserted;
    counts.failed += q.failed;
  }

  return counts;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI entry: defaults to weekly, --daily flips mode.
// ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const daily = process.argv.includes("--daily");
  if (daily) {
    // FIX-727's rule for a standalone entrypoint: a failed run exits nonzero.
    const r = await runEdgarDailyPipeline();
    if (r.fatal_error) process.exitCode = 1;
  } else {
    await runEdgarPipeline();
  }
}

const invokedDirectly = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return require.main === module;
  } catch {
    return true;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
