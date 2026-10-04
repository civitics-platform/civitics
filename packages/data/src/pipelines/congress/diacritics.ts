/**
 * FIX-1277 — fold accented letters to their base letter, in TS and in SQL.
 *
 * Congress.gov spells members with their accents (Barragán, García, Luján);
 * FEC files them without (BARRAGAN, GARCIA, LUJAN). A comparison key that
 * DELETES the accented letter instead of folding it can never match the two:
 * the merge script's `regexp_replace(upper(x), '[^A-Z]', '', 'g')` turned
 * BARRAGÁN into BARRAGN — the first refusal for 6 of the 12 FIX-1189 stubs
 * (docs/audits/2026-10-04-measure-first-census.md line 1685).
 *
 * Both forms are byte-identical for an ASCII name.
 */

/**
 * Unicode-decompose and drop the combining marks: `Luján` → `Lujan`. Case and
 * whitespace untouched — callers normalize those themselves. The FIX-940 idiom
 * from votes-maps, extracted so the promotion's name key and the Senate vote
 * map fold the same way.
 */
export function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * The SQL side. Prod has no `unaccent` extension (no migration creates it), so
 * the fold is a `translate()` table — these are the letters in Spanish and
 * Portuguese surnames on the federal roster, upper case then lower case. The
 * lower half is belt-and-braces: `upper()` maps á → Á under the en_US.UTF-8
 * ctype both databases use (measured 2026-10-04), but a C-ctype clone would
 * leave it lower case, and the strip would delete it there too.
 */
export const SQL_FOLD_FROM = "ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÇÃÕáéíóúüñàèìòùâêîôûçãõ";
export const SQL_FOLD_TO = "AEIOUUNAEIOUAEIOUCAOAEIOUUNAEIOUAEIOUCAO";

/** `translate(upper(<expr>), …)` — the upper-cased, accent-folded expression. */
export function sqlFoldUpper(expr: string): string {
  return `translate(upper(${expr}), '${SQL_FOLD_FROM}', '${SQL_FOLD_TO}')`;
}

/**
 * What `regexp_replace(sqlFoldUpper(x), '[^A-Z]', '', 'g')` returns, in TS —
 * for tests, and so a reader can check the table without a database.
 */
export function sqlLetterKey(s: string): string {
  let out = "";
  for (const ch of s.toUpperCase()) {
    const i = SQL_FOLD_FROM.indexOf(ch);
    out += i >= 0 ? SQL_FOLD_TO[i] : ch;
  }
  return out.replace(/[^A-Z]/g, "");
}
