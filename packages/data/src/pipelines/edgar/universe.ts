/**
 * FIX-253 · S&P 500 universe loader.
 *
 * Source CSV (data/sp500.csv) was copied from
 *   https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv
 * on 2026-05-11. Refresh procedure: re-fetch the file with the SEC-compliant
 * User-Agent and overwrite. Annual cadence is fine — index turnover is small
 * and EDGAR keeps responding for delisted CIKs.
 *
 * Header: Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,
 *         Date added,CIK,Founded
 */

import * as fs from "fs";
import * as path from "path";
import { parse as csvParse } from "csv-parse/sync";
import { padCik } from "./util";

export interface UniverseEntry {
  ticker:  string;
  name:    string;
  cik:     string;          // 10-digit zero-padded
  sector:  string;
}

let cache: UniverseEntry[] | null = null;

export function loadSp500Universe(): UniverseEntry[] {
  if (cache) return cache;

  const csvPath = path.join(__dirname, "data", "sp500.csv");
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows: Record<string, string>[] = csvParse(raw, { columns: true, skip_empty_lines: true });

  const out: UniverseEntry[] = [];
  for (const r of rows) {
    const ticker = (r["Symbol"] ?? "").trim();
    const name   = (r["Security"] ?? "").trim();
    const cikRaw = (r["CIK"] ?? "").trim();
    const sector = (r["GICS Sector"] ?? "").trim();
    if (!ticker || !name || !cikRaw) continue;
    out.push({ ticker, name, cik: padCik(cikRaw), sector });
  }

  cache = out;
  return out;
}

/**
 * Lookup-friendly variant: returns the universe as a Map keyed by 10-digit CIK.
 * Used by the daily-index scanner to filter SC 13D/G filings to tracked CIKs.
 */
export function loadSp500UniverseByCik(): Map<string, UniverseEntry> {
  const m = new Map<string, UniverseEntry>();
  for (const e of loadSp500Universe()) m.set(e.cik, e);
  return m;
}
