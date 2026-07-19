# Phase 04 — Reject Repeat Writes to the Same Path Within a Turn

**Depends on:** nothing (fully independent; Step 1 cites Phase 02's discriminated
union only as a style precedent) · **Enables:** nothing downstream; independent
hardening of the second prefix-loss route

## Goal

`resolveWritePathInteractive` (`fs-write.ts:67-74`) short-circuits any write to a
path already in `filesWrittenThisTurn` straight to `overwrite: true` — no
existence check, no conflict modal, no warning — and the executor still returns
the cheerful `Wrote: ${finalPath}` (`fs-write.ts:140`). A model that chunks a
long document across several `fs_write_text` calls therefore sees three successes
and leaves only the final chunk on disk. This is a prefix-loss route entirely
independent of the parser: it needs no truncation and survives every Phase 02
fix. This phase makes the second write to a path fail loudly with guidance
toward the correct tool.

## Files touched

- `src/lib/agent/tools/fs-write.ts` — reject rather than silently clobber at
  lines 67-74; add the error text.
- `src/lib/agent/tools/fs-write.test.ts` — repeat-write rejection cases.

## Steps

1. In `resolveWritePathInteractive` (line 67), replace the
   `filesWrittenThisTurn.has(relPath)` fast path. Widen the return type from
   `ResolvedWritePath | null` to an explicit discriminated union, mirroring the
   style Phase 02 introduces in the parser:
   ```ts
   type WriteResolution =
   	| { kind: 'ok'; finalPath: string; overwrite: boolean }
   	| { kind: 'canceled' }
   	| { kind: 'rejected'; message: string };
   ```
   The `filesWrittenThisTurn.has(relPath)` branch returns `{ kind: 'rejected' }`
   with the message from Step 2. Today's `null` return becomes
   `{ kind: 'canceled' }`, which the caller maps to the existing
   `userCanceledWriteError(relPath, command)` (`fs-write.ts:130`) so cancel
   behaviour is byte-identical. A union is preferred over an out-of-band throw
   because `fsWriteWithConflictCheck` already branches on the resolution and the
   compiler will then force every call site to handle the new case.
2. Word the tool error so it tells the model what to do instead — the model reads
   this and must be able to self-correct:
   *"`<path>` was already written in this turn. Do not write a file in pieces —
   emit one fs_write_text call containing the file's complete content. To amend a
   file you already wrote, use fs_edit_text."*
3. Apply the guard to **all** turn-scoped write executors that share
   `filesWrittenThisTurn`, not just `fs_write_text` — the same chunking failure
   applies to `fs_write_pdf`, `fs_write_docx` and `fs_write_xlsx`. Verify by
   tracing every caller of `fsWriteWithConflictCheck` (`fs-write.ts:122`).
4. Confirm the guard is scoped to a single turn and reset between turns, so a
   legitimate rewrite in a *later* turn is unaffected. `filesWrittenThisTurn` is
   already per-turn state; assert this with a test rather than assuming it.
5. Leave `isAutoApproveActive()` (lines 89-91) alone. It forces
   `overwrite: true` for job runs so writes don't block on a modal with no user
   present, which is correct — the defect was the *silent repeat*, not
   auto-approve itself.
6. Record the accepted trade-off: a model that legitimately writes a file and
   then wants to correct it within the same turn must now either re-emit the
   complete content in a later turn or use `fs_edit_text`. This follows the
   project's fail-loudly rule and is preferred over a size-based heuristic, which
   would false-trigger on legitimate large deletions.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

Automated:

- First write to a path returns `Wrote: <path>`; a second write to the **same**
  path in the same turn returns an error whose text names both `fs_edit_text` and
  the complete-content instruction.
- The rejected second write does **not** modify the file on disk — assert the
  content is still the first write's, which is the actual data-loss property.
- Writes to two *different* paths in one turn both succeed.
- A repeat write in a *subsequent* turn succeeds, proving per-turn scoping.
- The guard applies to `fs_write_pdf` / `fs_write_docx` / `fs_write_xlsx`, not
  only `fs_write_text`.
- Auto-approve mode still overwrites a pre-existing file that was **not** written
  earlier in the same turn — the guard must not break ordinary job writes.

Manual:

- Run a guided-planning job and confirm normal phase writing is unaffected: five
  phase files, five distinct paths, no rejections.

## Commit

```
fix(fs-write): reject a second write to the same path within one turn

resolveWritePathInteractive short-circuited any path already in
filesWrittenThisTurn to overwrite:true with no check and no warning, and the
executor still returned "Wrote: <path>". A model that chunked a long
document across several fs_write_text calls saw three successes and left
only the final chunk on disk — a prefix-loss route requiring no truncation
at all.

The repeat now fails with guidance to send complete content in one call, or
use fs_edit_text to amend. Applies to every turn-scoped write executor.
```

## Rollback

Revert the commit. The change is confined to one function and its error text, and
restores the silent-clobber behaviour on revert. Safe to leave partially applied
in the sense that reverting only the non-text writers' coverage still leaves
`fs_write_text` — the path guided planning actually uses — protected.
