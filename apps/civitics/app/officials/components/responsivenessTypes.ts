// QWEN-ADDED: shared types and helper for civic initiative responsiveness
//
// @deprecated ORPHANED — nothing imports this module. It was a byte-for-byte
// duplicate of app/api/officials/[id]/responsiveness/_lib.ts; both the card and
// the detail page import the types from _lib.ts directly.
//
// FIX-905 reduced it to a re-export rather than deleting it (file deletions need
// Craig's sign-off). The point of the reduction is that the removed A-F grade
// formula — `gradeFromRate` and the `ResponsivenessGrade` type — lived here in a
// second copy, so leaving the file intact would have kept the deleted score
// alive in the tree. Deletion candidate: this file has no consumers.

export type { ResponsivenessData } from "../../api/officials/[id]/responsiveness/_lib";
