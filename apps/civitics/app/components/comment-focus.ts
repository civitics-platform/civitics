// C1 Wave B (FIX-529): a tiny decoupled bus so surfaces OUTSIDE EntityComments
// (the debate map, the highlights strip) can ask the comment list to select +
// scroll to a comment without prop-drilling shared state across the page tree.
// EntityComments listens for FOCUS_COMMENT_EVENT and owns the selection/scroll.
// Its own file (not EntityComments) to avoid an import cycle with DebateMap.

export const FOCUS_COMMENT_EVENT = "civitics:focus-comment";

export interface FocusCommentDetail {
  id: string;
}

export function focusComment(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FocusCommentDetail>(FOCUS_COMMENT_EVENT, { detail: { id } }),
  );
}

export function commentDomId(id: string): string {
  return `comment-${id}`;
}
