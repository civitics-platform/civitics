/**
 * FIX-251 · LittleSis pipeline — shared helpers.
 *
 * LittleSis attribution (CC-BY-SA 4.0): data downloaded from
 * https://littlesis.org/database is licensed under CC-BY-SA 4.0
 * (https://creativecommons.org/licenses/by-sa/4.0/). The full attribution
 * notice is in this directory's README.md and is repeated in the orchestrator
 * file header and migration 20260511000001.
 */

import { createReadStream, createWriteStream, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";

// ---------------------------------------------------------------------------
// Source URLs + attribution
// ---------------------------------------------------------------------------

export const LITTLESIS_ENTITIES_URL =
  "https://littlesis.org/database/public_data/entities.json.gz";
export const LITTLESIS_RELATIONSHIPS_URL =
  "https://littlesis.org/database/public_data/relationships.json.gz";

export const ATTRIBUTION =
  "Data from LittleSis (https://littlesis.org), licensed CC-BY-SA 4.0 " +
  "(https://creativecommons.org/licenses/by-sa/4.0/). Derivative datasets " +
  "must share-alike and attribute LittleSis.";

export const USER_AGENT =
  "Civitics/1.0 (civic data platform; contact@civitics.com)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LittleSisEntity {
  id: number;
  name: string;
  blurb?: string | null;
  summary?: string | null;
  website?: string | null;
  parent_id?: number | null;
  primary_ext: "Org" | "Person";
  updated_at?: string;
  start_date?: string | null;
  end_date?: string | null;
  aliases?: string[];
  types?: string[];
}

export interface LittleSisRelationship {
  id: number;
  entity1_id: number;
  entity2_id: number;
  category_id: number;
  category_name?: string;
  description1?: string | null;
  description2?: string | null;
  amount?: number | null;
  currency?: string | null;
  goods?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  is_current?: boolean | null;
  is_featured?: boolean;
  updated_at?: string;
  category_attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Category → connection_type mapping
//
// LittleSis category 5 (Donation) is intentionally DROPPED — FEC bulk is
// authoritative for campaign donations and overlapping rows would skew
// donor totals. Drop happens at ingest time (util.shouldSkipCategory).
// ---------------------------------------------------------------------------

export type LittleSisCategory = 1 | 3 | 5 | 6 | 7 | 10 | 11 | 12;

export const SKIPPED_CATEGORIES: ReadonlySet<number> = new Set([5]);

export const CATEGORY_TO_CONNECTION_TYPE: Record<number, string> = {
  1:  "appointment",       // Position / Employment
  3:  "member_of",         // Membership
  6:  "business_partner",  // Transaction / business dealing
  7:  "lobbying",          // Lobbying
  10: "owns",              // Ownership (equity, stock holdings — distinct from
                           //  `holds_position` which is FR-derived investment)
  11: "parent_of",         // Hierarchy — entity1 is parent of entity2
  12: "affiliated_with",   // Generic / partnership
};

export const CATEGORY_NAMES: Record<number, string> = {
  1:  "Position",
  3:  "Membership",
  5:  "Donation",
  6:  "Transaction",
  7:  "Lobbying",
  10: "Ownership",
  11: "Hierarchy",
  12: "Generic",
};

export function shouldSkipCategory(catId: number): boolean {
  return SKIPPED_CATEGORIES.has(catId);
}

// ---------------------------------------------------------------------------
// Download + SHA256 fingerprint (streamed — never holds the .gz in memory)
// ---------------------------------------------------------------------------

export interface DownloadResult {
  sha256: string;
  bytes:  number;          // size of the .gz on disk
  path:   string;
}

export async function downloadAndFingerprint(
  url:      string,
  destPath: string,
): Promise<DownloadResult> {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok || !resp.body) {
    throw new Error(`LittleSis download ${url} → HTTP ${resp.status}`);
  }

  const hash = createHash("sha256");
  const out  = createWriteStream(destPath);

  // Tap each chunk through the hasher as it streams to disk. No buffering.
  const reader = resp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    }
  } finally {
    out.end();
    await new Promise<void>((r) => out.once("close", () => r()));
  }

  const bytes  = statSync(destPath).size;
  const sha256 = hash.digest("hex");
  return { sha256, bytes, path: destPath };
}

export function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Stream NDJSON-per-line from a .gz file
//
// LittleSis bulk dumps are NDJSON (one JSON object per line). If the first
// byte is `[` we fall back to single-array parsing (decompress to string,
// JSON.parse, iterate) — slower path, but safe.
// ---------------------------------------------------------------------------

export async function* streamGzipJson<T>(path: string): AsyncIterable<T> {
  // Decompress entire .gz into a single Buffer, then scan the bytes for
  // record boundaries and yield one record at a time. Both NDJSON (one JSON
  // object per line) and JSON-array (`[{...},{...},...]`) formats fall out
  // for free — we look for `{`-rooted objects, balance brace depth respecting
  // strings + escapes, and JSON.parse each substring individually.
  //
  // Single-record toString is bounded by the size of one record (a few KB),
  // so this never hits V8's ~512 MB single-string limit even when the whole
  // decompressed dump is >1 GB. An earlier revision toString'd the entire
  // buffer and crashed on the LittleSis relationships dump (~500 MB).
  //
  // Memory at peak: decompressed buffer (~500 MB for the relationships dump)
  // + Node baseline + V8 working set. Run with
  // NODE_OPTIONS=--max-old-space-size=8192.
  const stream = createReadStream(path).pipe(createGunzip());
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  chunks.length = 0;
  if (buf.length === 0) return;

  // Skip UTF-8 BOM + leading whitespace.
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;

  while (i < buf.length) {
    // Skip whitespace, commas, and array brackets between records.
    while (i < buf.length) {
      const b = buf[i]!;
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x2c /* , */ || b === 0x5b /* [ */) { i++; continue; }
      break;
    }
    if (i >= buf.length || buf[i] === 0x5d /* ] */) return;
    if (buf[i] !== 0x7b /* { */) { i++; continue; }   // resync on stray bytes

    // Walk one `{...}` record, tracking brace depth + string mode + escapes.
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc   = false;
    for (; i < buf.length; i++) {
      const b = buf[i]!;
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (b === 0x5c /* \ */) { esc = true; continue; }
        if (b === 0x22 /* " */) { inStr = false; continue; }
        continue;
      }
      if (b === 0x22 /* " */) { inStr = true; continue; }
      if (b === 0x7b /* { */) depth++;
      else if (b === 0x7d /* } */) {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    if (depth !== 0) return;   // truncated record at EOF — silently stop

    try {
      const raw = JSON.parse(buf.slice(start, i).toString("utf8")) as unknown;
      // LittleSis ships the JSON:API envelope: {type:"...", id:N, attributes:{...}}.
      // Yield .attributes when present so downstream code sees a flat record.
      if (raw && typeof raw === "object" && "attributes" in (raw as Record<string, unknown>)) {
        const r = raw as { attributes?: T };
        if (r.attributes) yield r.attributes;
        else yield raw as T;
      } else {
        yield raw as T;
      }
    } catch {
      // Skip malformed records — LittleSis dumps occasionally include
      // a metadata line or trailing partial record.
    }
  }
}

// ---------------------------------------------------------------------------
// pipeline_state row helpers — fingerprint freshness gate
// ---------------------------------------------------------------------------

export interface LittleSisStoredState {
  entities_sha:      string | null;
  relationships_sha: string | null;
  last_run_at:       string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getStoredFingerprint(db: any): Promise<LittleSisStoredState> {
  try {
    const { data } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", "littlesis_state")
      .maybeSingle();
    const v = (data?.value ?? {}) as Record<string, string | null>;
    return {
      entities_sha:      v["entities_sha"]      ?? null,
      relationships_sha: v["relationships_sha"] ?? null,
      last_run_at:       v["last_run_at"]       ?? null,
    };
  } catch {
    return { entities_sha: null, relationships_sha: null, last_run_at: null };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function storeFingerprint(db: any, entSha: string, relSha: string): Promise<void> {
  try {
    await db.from("pipeline_state").upsert(
      {
        key: "littlesis_state",
        value: {
          entities_sha:      entSha,
          relationships_sha: relSha,
          last_run_at:       new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
  } catch {
    // non-fatal — the run still wrote rows
  }
}

// ---------------------------------------------------------------------------
// State-code parsing from LittleSis types[] / aliases[]
//
// LittleSis sometimes tags US politicians with the state in the types array
// (e.g. "US_State_Representative_TX") or as an alias like "Senator from KY".
// We extract a 2-letter US state code when present; null otherwise.
// ---------------------------------------------------------------------------

const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP",
]);

export function parseStateHint(ent: LittleSisEntity): string | null {
  // Types: search for any 2-uppercase-letter token at end of an underscore-
  // separated tag, e.g. "Republican_Party_US_TX".
  for (const t of ent.types ?? []) {
    const tokens = t.split(/[_\s]/).filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i]?.toUpperCase();
      if (tok && tok.length === 2 && STATE_CODES.has(tok)) return tok;
    }
  }
  // Aliases: search for trailing " from XX" or " (XX)" patterns.
  for (const a of ent.aliases ?? []) {
    const m = a.match(/(?:from|\()\s*([A-Za-z]{2})\b/);
    const code = m?.[1]?.toUpperCase();
    if (code && STATE_CODES.has(code)) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LittleSis Org type → financial_entities.entity_type
// ---------------------------------------------------------------------------

export type CivEntityType =
  | "individual" | "pac" | "super_pac" | "corporation" | "union"
  | "party_committee" | "small_donor_aggregate" | "tribal" | "527" | "other";

export function littleSisOrgEntityType(types: string[] | undefined): CivEntityType {
  const t = (types ?? []).map((s) => s.toLowerCase());
  if (t.some((s) => s.includes("labor") || s === "union")) return "union";
  if (t.some((s) => s.includes("political_fundraising") || s.includes("political party") || s === "politicalparty")) return "party_committee";
  if (t.some((s) => s.includes("pac"))) return "pac";
  if (t.some((s) => s.includes("tribal") || s.includes("tribe"))) return "tribal";
  if (t.some((s) => s.includes("business") || s.includes("public_company") || s.includes("publiccompany") || s.includes("corporation"))) return "corporation";
  return "other";
}

