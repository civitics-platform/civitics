# `docs/FIXES.md` Edit-tool corruption post-mortem — 2026-05-18

## Summary

Cowork ran four `Edit` operations against `docs/FIXES.md` on 2026-05-18 to
file follow-up FIX bullets FIX-308 / FIX-309 / FIX-310 / FIX-311 in their
respective sections. The Cowork session reported that two of the four Edit
operations corrupted the file — each anchored on an existing `<!--id:FIX-NNN-->`
marker and replaced the anchor plus everything from that anchor through
end-of-file. The third corruption left the file truncated mid-sentence in
FIX-304 with no trailing newline and the `COMMUNITY & AUTH`, `DOCUMENTATION`,
and `COMPLETED` sections missing.

This post-mortem documents what was on disk by the time the recovery session
(VS Code Claude Code) opened the file, what reproduction was attempted, and
the recommendation for future FIXES.md appends from Cowork.

## State on disk at recovery time

By the time the recovery session inspected `docs/FIXES.md`, the file was:

- 215 lines (HEAD was 211 — exactly +4, matching the four new bullets).
- FIX-308 present at line 37, inside `BUGS — Fix These First`, immediately
  after FIX-221.
- FIX-309 present at line 46, inside `GENERAL / CROSS-CUTTING`, immediately
  after FIX-241.
- FIX-310 present at line 47, inside `GENERAL / CROSS-CUTTING`, immediately
  after FIX-309.
- FIX-311 present at line 198, inside `INFRASTRUCTURE & PERFORMANCE`,
  immediately after FIX-306.
- Trailing `COMMUNITY & AUTH` (line 203), `DOCUMENTATION` (line 208), and
  `COMPLETED` (line 213) sections intact.
- All FIX IDs 280-311 present exactly once.
- File ends with a single trailing newline (one `0x0a` byte at EOF).

In other words: the working tree state CC inspected matched the desired end
state of the filing operation, not the corrupted state the Cowork session
reported. The bullets are in their intended sections, text matches the prompt
verbatim, and no FIX IDs are missing or duplicated.

A forensic snapshot of this state is preserved at
[`docs/audits/fixes-md-corruption-2026-05-18.txt`](fixes-md-corruption-2026-05-18.txt).

## Reproduction attempt

Hypothesis from the original prompt: when Edit's `new_string` begins with the
same substring as `old_string`, the tool's replacement boundary extends past
the anchor and consumes content through end-of-file.

Reproduction at `.drain-tmp/edit-test-scratch.txt`:

```
Before edit (6 lines + trailing newline):
  head line
  MARKER-FIX-306
  body line 1
  body line 2
  body line 3
  final line

Edit:
  old_string = "MARKER-FIX-306"
  new_string = "MARKER-FIX-306\n- [ ] new bullet here ending in <!--id:FIX-311-->"

After edit:
  head line
  MARKER-FIX-306
  - [ ] new bullet here ending in <!--id:FIX-311-->
  body line 1
  body line 2
  body line 3
  final line
```

Result: clean insert, 8 lines, body preserved. **Hypothesis refuted on this
machine with this Edit tool implementation.** Whatever caused the corruption
in Cowork's session is not a simple "new_string starts with old_string"
trigger of the Edit tool.

## Reflog check for parallel writers

`git reflog --date=iso` shows the activity on 2026-05-18 leading up to the
corruption window. All commits in the relevant window come from the single
local session — sequential, single-author (`Civitics Platform`), no evidence
of a competing writer in the local reflog:

```
14621fc6 2026-05-18 19:44:30 -0700  chore(fixes): sync ... FIX-292+293 + FIX-307 allocation
22e9a467 2026-05-18 19:44:16 -0700  docs(fixes): allocate FIX-307
d5661dd7 2026-05-18 19:28:51 -0700  docs(fixes): allocate FIX-304, FIX-305, FIX-306
452bdcc3 2026-05-18 19:14:33 -0700  chore(fixes): sync status after FIX-301, FIX-302
```

This does not rule out a parallel writer in Cowork's own sandboxed environment
or in a separate CC session that wasn't logged here — only that the VS Code
session's reflog is consistent.

## Plausible remaining causes

With the simple-string-prefix hypothesis refuted and the local reflog clean,
the remaining plausible causes for the Cowork-side corruption are:

1. **Cowork sandbox state-keeping bug** — the Edit tool's view of file state
   in Cowork's sandbox diverged from disk between operations, and a stale
   in-memory view was written back over the live file.
2. **Concurrent writer outside the local reflog** — another tool (linter,
   IDE save-on-blur, secondary CC session connected to the same workspace
   via Cowork's collaboration model) wrote to `docs/FIXES.md` between
   Cowork's Edit operations.
3. **Transient editor view mistaken for disk state** — Cowork's session
   reported corruption based on a view it had of the file rather than its
   on-disk bytes, and disk was actually fine the whole time. The +4-line
   end state in the working tree is consistent with this.

No single cause is confirmed.

## Recommendation

For Cowork specifically, when appending to `docs/FIXES.md`:

- **Prefer atomic `Write` of the full file content over surgical `Edit`.**
  FIXES.md is large enough that a Write of the full content is cheap, and a
  whole-file Write is immune to any boundary-extension or stale-view bug in
  the Edit tool implementation, whatever the actual cause was here.
- If you must use `Edit`, always `Read` the file immediately before each
  Edit, and immediately verify the result with another `Read` after each
  Edit before proceeding. Catch corruption at write time, not after the
  third operation.
- Use the bullet's `<!--id:FIX-NNN-->` marker as the anchor regardless — it's
  short and unique. The recommendation is purely about which write tool is
  safer, not about anchor choice.

For VS Code Claude Code (this session's environment), `Edit` against
FIXES.md is verified safe under the conditions tested. The recommendation
applies to Cowork sessions where the same operation behaved differently.

## Memory update

The Cowork workspace memory path named in the originating prompt
(`%AppData%/Roaming/Claude/local-agent-mode-sessions/…/memory/`) was not
present on this machine when CC checked. The rule is captured in this
post-mortem instead; if Cowork sessions need a memory pin, add a
`feedback_fixes_md_editing.md` to the active Cowork memory path with the
"prefer Write over Edit for FIXES.md" recommendation from this document.

## What was NOT done

- No code or migration changes.
- No FIXES.md text rewrites — append-only contract honored. The four new
  bullets are filed verbatim from the originating prompt.
- No closing of bullets. FIX-308 / FIX-309 / FIX-310 / FIX-311 land open;
  whoever picks them up next ships them.
- No restore from HEAD. The file's working-tree state already matched the
  target end state when CC opened it.
