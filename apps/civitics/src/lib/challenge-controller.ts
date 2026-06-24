// FIX-576: bridge between the non-React `challengedFetch` layer and the React
// <ChallengeModal>. `challengedFetch` is a plain async function and can't render
// UI, so when a managed (invisible) Turnstile challenge escalates to interactive
// it calls `requestInteractiveChallenge()`. The ChallengeModal mounted once at
// the app root registers itself via `setChallengeOpener` and fulfils the request
// by showing a visible, solvable widget.
//
// Resolves the solved token, or `null` when the modal isn't mounted (no site key
// / preview env), the user dismisses, or the widget errors — in which case the
// caller surfaces the original 403, exactly as before this fix. This is never
// load-bearing for site function.

type Resolver = (token: string | null) => void;

/** The modal registers this; invoked with a resolver each time a challenge is requested. */
type Opener = (resolve: Resolver) => void;

let opener: Opener | null = null;

/** Called once by the mounted <ChallengeModal>; pass `null` on unmount. */
export function setChallengeOpener(next: Opener | null): void {
  opener = next;
}

/**
 * Ask the mounted modal to host a visible interactive Turnstile challenge.
 * Resolves the solved token, or `null` if the modal isn't mounted, the user
 * dismisses, or the widget errors — the caller then surfaces the original 403
 * (today's behavior). Safe to call from non-React code.
 */
export function requestInteractiveChallenge(): Promise<string | null> {
  if (!opener) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    opener!(resolve);
  });
}
