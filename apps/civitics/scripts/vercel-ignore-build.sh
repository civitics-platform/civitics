#!/usr/bin/env bash
# FIX-1359 — the civitics project's Ignored Build Step (apps/civitics/vercel.json
# "ignoreCommand"). Vercel runs it in the project's Root Directory
# (apps/civitics) before every git-triggered deployment, with git available:
#   exit 0 → SKIP the build (the deployment reads Canceled)
#   exit 1 → BUILD
# Before it, `[skip vercel]` did nothing: Vercel has no commit-message skip of
# its own, and every tagged or docs-only push built production (cc-249).
#
# THE RANGE, NOT THE TIP. Vercel builds only a push's newest commit, so the
# question is "what changed since the last deployment that SUCCEEDED", which
# Vercel exposes to this step as VERCEL_GIT_PREVIOUS_SHA. `git diff HEAD^ HEAD`
# answers the wrong question: a push whose tip is an empty record commit
# (every cc run's records push) above an app change would read "nothing
# changed" and skip it, and a tagged tip would hide untagged commits under it.
#
# SKIP when, over PREVIOUS..HEAD,
#   (a) every commit's subject carries [skip vercel], or
#   (b) nothing deployable changed: this directory, ../../packages, or the
#       root package.json / pnpm-lock.yaml / pnpm-workspace.yaml / turbo.json
#       / .npmrc (docs, receipts, the bots, supabase/, scripts/ do not ship).
# BUILD on anything else — including no PREVIOUS sha, a PREVIOUS the shallow
# clone cannot reach, or a redeploy of the same commit. A doubt builds.
# A tagged-only range skips even when it changes app code: that is what the tag
# means (CLAUDE.md §Commit conventions). The next untagged push — at the
# latest the 00:09Z receipts bot — sees the whole range and builds it.
# The tag counts only where it HEADS the subject (FIX-1364): a subject that
# quotes it mid-line, such as a record commit quoting a skip line, is untagged.
#
# PREVIEWS NEVER BUILD. Before this file the project's dashboard Ignored Build
# Step skipped every Preview (feature-branch pushes; every one Canceled back to
# at least 10-18) and let every Production build. vercel.json's ignoreCommand
# OVERRIDES that setting, so the dashboard rule is restated here first —
# without it the first branch push after FIX-1359 built a 2-minute preview.
set -u
if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "skip: VERCEL_ENV=${VERCEL_ENV:-unset} — only production builds"
  exit 0
fi
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$prev" ]; then
  echo "build: no VERCEL_GIT_PREVIOUS_SHA"
  exit 1
fi
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  git fetch --quiet --deepen=200 2>/dev/null || true
fi
if ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "build: ${prev} is not reachable in this clone"
  exit 1
fi
n="$(git rev-list --count "${prev}..HEAD")"
if [ "$n" -eq 0 ]; then
  echo "build: HEAD is the last deployed commit (a redeploy)"
  exit 1
fi
untagged="$(git log --format=%s "${prev}..HEAD" | grep -cvE '^\[skip vercel\]')"
if [ "$untagged" -eq 0 ]; then
  echo "skip: all ${n} commit(s) since ${prev:0:8} are [skip vercel]"
  exit 0
fi
if git diff --quiet "$prev" HEAD -- . ../../packages ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ../../turbo.json ../../.npmrc; then
  echo "skip: nothing deployable changed in ${n} commit(s) since ${prev:0:8}"
  exit 0
fi
echo "build: deployable paths changed in ${n} commit(s) since ${prev:0:8}"
exit 1
