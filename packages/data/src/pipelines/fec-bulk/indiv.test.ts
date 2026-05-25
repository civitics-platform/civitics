/**
 * Anchor cases for FIX-239 Layer 1 + FIX-244.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/indiv.test.ts
 *
 * The TS donorFingerprint() and the SQL canonical_donor_fingerprint() must
 * produce identical output for every (name, zip5) pair — pipeline idempotency
 * depends on it. This file pins the TS half; the migration's RAISE NOTICE
 * output and the post-migration verification queries pin the SQL half against
 * real data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { donorFingerprint } from "./indiv";

// Convenience: assert the produced fingerprint equals an exact string.
function fp(name: string, zip5: string): string {
  return donorFingerprint(name, zip5);
}

// ── §2.3 anchors: variants that SHOULD collapse to the same fingerprint ────

test("FIX-239 §2.3 MCKEE JACK — MR honorific drops", () => {
  // MCKEE, JACK and MCKEE, JACK MR. collapse (MR is noise).
  assert.equal(fp("MCKEE, JACK",     "37363"), fp("MCKEE, JACK MR.", "37363"));
  // Layer 1 preserves middle initials — JACK and JACK C. remain distinct.
  // That's intentional (the §2.3 mid-initial collapses are a Layer 2 win,
  // not Layer 1). Confirm split is preserved.
  assert.notEqual(fp("MCKEE, JACK", "37363"), fp("MCKEE, JACK C.", "37363"));
  // But JACK C. and JACK C. MR. collapse — same person, just MR added.
  assert.equal(fp("MCKEE, JACK C.", "37363"), fp("MCKEE, JACK C. MR.", "37363"));
});

test("FIX-239 §2.3 SCHWARZMAN STEPHEN — MR honorific drops", () => {
  assert.equal(
    fp("SCHWARZMAN, STEPHEN A.",       "10154"),
    fp("SCHWARZMAN, STEPHEN A. MR.",  "10154"),
  );
});

test("FIX-239 §2.3 WINKLEVOSS CAMERON — MR honorific drops", () => {
  assert.equal(
    fp("WINKLEVOSS, CAMERON",       "10010"),
    fp("WINKLEVOSS, CAMERON MR.",  "10010"),
  );
});

test("FIX-239 §2.3 CHILDS JOHN — MR honorific drops", () => {
  assert.equal(
    fp("CHILDS, JOHN W.",      "32963"),
    fp("CHILDS, JOHN W. MR.", "32963"),
  );
});

test("FIX-239 §2.3 LEVY EDWARD — MR drops, JR preserved", () => {
  // LEVY, EDWARD MR. JR. and LEVY, EDWARD JR. collapse (MR is noise, JR preserved).
  assert.equal(
    fp("LEVY, EDWARD MR. JR.", "48009"),
    fp("LEVY, EDWARD JR.",     "48009"),
  );
});

// ── §2.4 anchors: distinct people that MUST stay split ────────────────────

test("FIX-239 §2.4 PEROT ROSS — SR vs JR stay split", () => {
  assert.notEqual(
    fp("PEROT, ROSS",     "75219"),
    fp("PEROT, ROSS JR.", "75219"),
  );
  // Force a SR variant for explicit father-son demonstration.
  assert.notEqual(
    fp("PEROT, ROSS SR.", "75219"),
    fp("PEROT, ROSS JR.", "75219"),
  );
});

test("FIX-239 §2.4 SMITH WILLIAM — middle initials stay split", () => {
  assert.notEqual(
    fp("SMITH, WILLIAM A. MR.", "03854"),
    fp("SMITH, WILLIAM B. MR.", "03854"),
  );
});

test("FIX-239 §2.4 TAYLOR ROBERT — middle initial / suffix combos stay split", () => {
  // COL/RET/USA are not in the noise list — they survive as tokens.
  // The V. middle initial and the JR. suffix also survive.
  assert.notEqual(
    fp("TAYLOR, ROBERT COL. RET. USA", "37027"),
    fp("TAYLOR, ROBERT V. DR. JR.",    "37027"),
  );
});

test("FIX-239 §2.4 O'BRIEN cluster — distinct first names stay split", () => {
  // LARRY vs LAWRENCE F vs LAWRENCE III — all distinct people, distinct fps.
  const a = fp("O'BRIEN, LARRY",         "20007");
  const b = fp("O'BRIEN, LAWRENCE F.",   "20007");
  const c = fp("O'BRIEN, LAWRENCE III",  "20007");
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

// ── FIX-244: apostrophe-stripping correctness ──────────────────────────────

test("FIX-244 apostrophes strip to empty string, not whitespace", () => {
  // O'BRIEN must become OBRIEN — single token, not split.
  assert.equal(fp("O'BRIEN, LARRY", "20007"), "OBRIEN LARRY|20007");
  // D'ANGELO -> DANGELO
  assert.equal(fp("D'ANGELO, MARIA", "10001"), "DANGELO MARIA|10001");
});

test("FIX-244 periods strip to empty string, not whitespace", () => {
  // ST. CLAIR -> ST CLAIR (period gone) → FIX-245 particle-joins ST+CLAIR.
  // Pre-FIX-245 this produced "ST CLAIR JOHN"; post-FIX-245 the "ST"
  // particle fuses into "STCLAIR JOHN", which is the desired collapse
  // (ST CLAIR / ST. CLAIR variants all converge to STCLAIR).
  assert.equal(fp("ST. CLAIR, JOHN", "90210"), "STCLAIR JOHN|90210");
  // M.D. as a trailing token after a comma stays a no-op (MD is noise and drops).
  assert.equal(fp("SMITH, JANE M.D.", "00000"), "SMITH JANE|00000");
});

// ── FIX-245: backtick strip + position-0 particle joiner ──────────────────

test("FIX-245 backtick strips like apostrophe (no token split)", () => {
  // ``O`BRIEN`` (backtick) → OBRIEN, same as O'BRIEN.
  assert.equal(fp("O`BRIEN, HALLEY MARIE", "20007"), "OBRIEN HALLEY MARIE|20007");
});

test("FIX-245 space-separated particle joins (O / D / ST / MC / DE)", () => {
  // The pre-FIX-245 residue path: raw FEC NAME field carries `O BRIEN`
  // with a literal space instead of an apostrophe. After FIX-245 the
  // position-0 O+BRIEN fuse runs.
  assert.equal(fp("O BRIEN, MICHAEL",  "78734"), "OBRIEN MICHAEL|78734");
  assert.equal(fp("D ANGELO, MARIA",   "10001"), "DANGELO MARIA|10001");
  assert.equal(fp("ST JAMES, JAMES",   "10001"), "STJAMES JAMES|10001");
  assert.equal(fp("MC CARTHY, KEVIN",  "20007"), "MCCARTHY KEVIN|20007");
});

test("FIX-245 apostrophe+space variant joins after apostrophe-strip", () => {
  // `O' BRIEN, HALLEY` → upper → strip apostrophe → "O BRIEN, HALLEY"
  // → tokenize → ["O","BRIEN","HALLEY"] → particle-join → "OBRIEN HALLEY".
  assert.equal(fp("O' BRIEN, HALLEY MARIE", "20007"), "OBRIEN HALLEY MARIE|20007");
});

test("FIX-245 single-letter 'O' is part of multi-char surname token (no fuse)", () => {
  // Regression — "OLIVER" must not particle-join. The position-0 token is
  // OLIVER, not O; particle test uses PARTICLE_TOKENS.has on the full
  // token, so OLIVER ≠ O and no fuse happens.
  assert.equal(fp("OLIVER, JAMES", "20007"), "OLIVER JAMES|20007");
});

test("FIX-245 multi-particle 'DE LA RENTA' — known residue, not fully cleaned", () => {
  // The particle joiner is position-0 only and joins exactly two tokens.
  // "DE LA RENTA, OSCAR" → tokens ["DE","LA","RENTA","OSCAR"] → fuse to
  // ["DELA","RENTA","OSCAR"]. "DELA RENTA" is wrong but documented — the
  // bullet's allow-list is narrow on purpose; multi-particle clusters
  // remain a follow-up.
  assert.equal(fp("DE LA RENTA, OSCAR", "10010"), "DELA RENTA OSCAR|10010");
});

test("FIX-245 leading honorific is dropped before the particle joiner runs", () => {
  // "MR O BRIEN, MICHAEL" → noise filter drops MR → ["O","BRIEN","MICHAEL"]
  // → particle-join → "OBRIEN MICHAEL". Order matters; if particle-join
  // ran before the noise filter, tokens[0]=MR would short-circuit.
  assert.equal(fp("MR O BRIEN, MICHAEL", "78734"), "OBRIEN MICHAEL|78734");
});

// ── Noise vs generational preservation rules ────────────────────────────────

test("honorific tokens drop (MR/MRS/MD/PHD/ESQ/...)", () => {
  // PHD is noise -> drops.
  assert.equal(fp("SMITH, JANE PHD",       "00000"), "SMITH JANE|00000");
  // ESQ drops.
  assert.equal(fp("DOE, JOHN ESQ.",         "00000"), "DOE JOHN|00000");
  // CPA drops.
  assert.equal(fp("LEE, ALEX CPA",          "00000"), "LEE ALEX|00000");
});

test("generational tokens preserved (JR/SR/II/III/IV/V)", () => {
  assert.notEqual(fp("SMITH, JOHN",     "00000"), fp("SMITH, JOHN SR", "00000"));
  assert.notEqual(fp("SMITH, JOHN",     "00000"), fp("SMITH, JOHN JR", "00000"));
  assert.notEqual(fp("SMITH, JOHN SR",  "00000"), fp("SMITH, JOHN JR", "00000"));
  assert.notEqual(fp("SMITH, JOHN III", "00000"), fp("SMITH, JOHN IV", "00000"));
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("blank or pure-noise input returns empty string", () => {
  assert.equal(fp("",            "12345"), "");
  assert.equal(fp("   ",         "12345"), "");
  // MR alone is pure noise.
  assert.equal(fp("MR",          "12345"), "");
  // Punctuation-only input.
  assert.equal(fp("...''",       "12345"), "");
});

test("missing zip5 emits name-only fingerprint", () => {
  assert.equal(fp("DOE, JOHN", ""), "DOE JOHN");
  assert.equal(fp("DOE, JOHN", "   "), "DOE JOHN");
});

test("zip5 truncates to first 5 chars (ZIP+4 input)", () => {
  // "20007-1234" should land as the 5-digit prefix.
  assert.equal(fp("DOE, JOHN", "20007-1234"), "DOE JOHN|20007");
});
