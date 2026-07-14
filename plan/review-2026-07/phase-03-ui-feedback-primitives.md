# Phase 03 — UI feedback primitives

**Commit scope:** `feat(ui)` · **Language:** TS/Svelte · **Depends on:** nothing · **Feeds:** phases 04 & 05

Three primitives the later phases consume: modal focus management, a
ConfirmDialog, and a toast system. All three land here so 04/05 are pure
call-site work.

---

## 1. Focus management in `Modal.svelte`

Today (`Modal.svelte:51-79`) the dialog sets `role="dialog"`/`aria-modal` but
never moves, traps, or restores focus — a keyboard user can Tab behind
`CommandApprovalModal`/`SandboxApprovalModal`. Only `UserQuestionModal.svelte:51`
self-focuses.

Implement **inside `Modal.svelte`** so every consumer inherits it:

- **On open** (`$effect` on `open`, after a tick): save
  `document.activeElement`; if focus is not already inside the dialog
  (preserves `UserQuestionModal`'s own input focus), focus the first
  `[autofocus]` element, else the first focusable
  (`button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])`),
  else the dialog element itself (give it `tabindex="-1"`).
- **Trap:** `keydown` handler on the dialog — on Tab/Shift+Tab at the
  boundary focusable, wrap to the other end. No inert/portal tricks; the
  keydown loop is enough for this app's flat DOM.
- **On close:** restore focus to the saved element if it's still in the
  document.

Behavioral invariant: the existing modals must stay byte-for-byte identical
visually (the "opt-in extras" contract in the file header). Focus behavior is
the only change.

## 2. `ConfirmDialog.svelte`

New `src/lib/components/ConfirmDialog.svelte`, built on `Modal` +
`ModalButton` (per maintenance.md §9 — no hand-rolled backdrops).

```ts
interface Props {
	open: boolean;
	title: string;               // e.g. "Delete conversation?"
	message?: string;            // plain-text body; use children for rich body
	confirmLabel?: string;       // default 'Delete'
	cancelLabel?: string;        // default 'Cancel'
	destructive?: boolean;       // default true → danger-variant ModalButton
	onconfirm: () => void;
	oncancel: () => void;
	children?: Snippet;
}
```

Locked behaviors:
- **Cancel has `autofocus`** (safe default — Enter never confirms a
  destructive action by accident).
- `dismissable` → Esc/backdrop call `oncancel`.
- Confirm button uses the danger variant when `destructive`, primary
  otherwise.

## 3. Toast system

**Store** `src/lib/stores/toasts.svelte.ts` (runes):

```ts
type ToastKind = 'info' | 'success' | 'error';
showToast(message: string, opts?: {
	kind?: ToastKind;          // default 'info'
	duration?: number;         // ms; default 5000, errors default 8000
	actionLabel?: string;      // optional single action (e.g. 'Retry', 'View logs')
	onAction?: () => void;
}): void
dismissToast(id: number): void
getToasts(): Toast[]
```

**Host** `src/lib/components/Toasts.svelte`, mounted once in
`+layout.svelte` (renders above all tabs):
- Bottom-right stack, max 4 visible, overflow queues FIFO.
- Container `aria-live="polite"`; `kind === 'error'` toasts additionally get
  `role="alert"`.
- Every toast has a manual dismiss `×` (with `aria-label="Dismiss"`).
- Enter/exit animation wrapped so phase 06's global reduced-motion override
  degrades it gracefully (no special-casing needed here — just use
  `animation`, not JS-driven transitions).
- Duplicate suppression: an identical `(kind, message)` already visible
  resets its timer instead of stacking.

---

## Tests & acceptance

Component tests (via the `@testing-library/svelte` harness from PR #114):
- Modal: opening moves focus inside; Tab from last focusable wraps to first;
  closing restores focus to the trigger; a modal whose child self-focuses is
  left alone.
- ConfirmDialog: Cancel focused on open; `onconfirm`/`oncancel` fire from the
  right buttons; Esc → `oncancel`.
- Toast store: fake-timer expiry, error duration default, max-4 + FIFO
  overflow, duplicate suppression.

Manual: open the sandbox-approval modal, verify Tab cannot reach the page
behind it.
