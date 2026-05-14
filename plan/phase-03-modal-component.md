# Phase 03 — Shared `Modal.svelte` component

**Severity addressed:** 9 · **Effort:** ~2 hours · **Risk:** Low

Resolves duplication-audit T-1 (60 LOC of identical CSS in two modals) and T-7 (3 modal components share structure).

## Goal

Create `src/lib/components/Modal.svelte` and `ModalButton.svelte`. Replace the open-state + backdrop + dialog wrapper in `FileConflictModal.svelte` and `SandboxApprovalModal.svelte`. `GpuWarningDialog.svelte` is optional in this phase (different class names).

## Files touched

- **NEW** `src/lib/components/Modal.svelte`
- **NEW** `src/lib/components/ModalButton.svelte`
- **EDIT** `src/lib/components/FileConflictModal.svelte`
- **EDIT** `src/lib/components/SandboxApprovalModal.svelte`

## Implementation

### Step 1 — `Modal.svelte`

```svelte
<!-- src/lib/components/Modal.svelte -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		maxWidth?: number;
		children: Snippet;
	}

	let { open, maxWidth = 520, children }: Props = $props();
</script>

{#if open}
	<div class="modal-backdrop">
		<div class="modal" style:max-width="{maxWidth}px">
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}
	.modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px 28px;
		width: 100%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}
	.modal :global(h2) {
		margin: 0 0 12px 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}
	.modal :global(p) {
		margin: 0 0 10px 0;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.5;
	}
</style>
```

### Step 2 — `ModalButton.svelte`

```svelte
<!-- src/lib/components/ModalButton.svelte -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'default' | 'overwrite' | 'deny' | 'cancel' | 'counter';
		onclick: () => void;
		title: Snippet;
		subtitle?: Snippet;
	}

	let { variant = 'default', onclick, title, subtitle }: Props = $props();
</script>

<button class="btn {variant}" {onclick}>
	<strong>{@render title()}</strong>
	{#if subtitle}<span>{@render subtitle()}</span>{/if}
</button>

<style>
	.btn {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.btn:hover { border-color: var(--accent); }
	.btn strong {
		display: block;
		font-size: 0.92rem;
		margin-bottom: 2px;
	}
	.btn span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}
	.btn.overwrite:hover, .btn.deny:hover { border-color: #ef4444; }
	.btn.cancel:hover  { border-color: var(--text-secondary); }
</style>
```

### Step 3 — refactor `FileConflictModal.svelte`

- Replace lines 24–48 with:
  ```svelte
  <Modal open={pending != null} maxWidth={520}>
    <h2>File already exists</h2>
    <p>The path <code>{pending.path}</code> is already on disk.</p>
    <p class="prompt-question">What would you like to do?</p>
    <div class="button-row">
      <ModalButton variant="overwrite" onclick={() => resolveConflict('overwrite')}>
        {#snippet title()}Overwrite{/snippet}
        {#snippet subtitle()}Replace the existing file{/snippet}
      </ModalButton>
      <ModalButton variant="counter" onclick={() => resolveConflict('counter')}>
        {#snippet title()}Save as new file{/snippet}
        {#snippet subtitle()}Append a counter to the filename{/snippet}
      </ModalButton>
      <ModalButton variant="cancel" onclick={() => resolveConflict('cancel')}>
        {#snippet title()}Cancel{/snippet}
        {#snippet subtitle()}Abort the write{/snippet}
      </ModalButton>
    </div>
  </Modal>
  ```
- Delete the `.modal-backdrop`, `.modal`, `.modal h2`, `.modal p`, `.btn`, `.btn:hover`, `.btn strong`, `.btn span` style rules (now shared).
- Keep file-specific styles only: `.modal code`, `.prompt-question`, `.button-row`, `.btn.overwrite`, `.btn.counter`, `.btn.cancel`.

### Step 4 — refactor `SandboxApprovalModal.svelte`

Same pattern, `maxWidth={640}`. Keep file-specific styles `.code-preview`, `.code-preview code`, `.button-row`, `.btn.deny`.

## Build gate

```bash
npm run check
npm run lint
npm run build   # ensures the static adapter doesn't break
```

## Test plan

### Smoke

1. App launches.

### Targeted — File-conflict modal

2. Set a working directory.
3. In chat: *"Create a file `dup.txt` with the contents 'first'."* — wait for the write.
4. In chat: *"Create a file `dup.txt` with the contents 'second'."* — the modal should appear.
5. Visually verify: backdrop dimmed, dialog centred, three buttons stacked vertically. Hover the first button — border should turn red; hover the third — border turns grey.
6. Click **Overwrite**. Tool result reports `Wrote: dup.txt`. `cat <workdir>/dup.txt` shows `second`.
7. Repeat with **Save as new file**. Verify a new file `dup_1.txt` (or similar suffix) appears.
8. Repeat with **Cancel**. Verify the agent reports the write was cancelled.

### Targeted — Sandbox-approval modal

9. With sandbox enabled, paste in chat: *"Run this Python: `print(1 + 1)`"*.
10. The approval modal appears. Verify wider dialog (640 px), code preview block, two buttons.
11. Click **Approve**. Python runs; output `2` is reported.
12. New prompt: *"Run this Python: `print(2 + 2)`"*. Click **Deny**. The agent receives an error and reports it.

If 2–12 pass, commit:

```
refactor: extract shared Modal and ModalButton components (#TBD)

Replaces 60 LOC of duplicated CSS in FileConflictModal.svelte
and SandboxApprovalModal.svelte with a shared Modal primitive
plus a ModalButton helper. No behavioural change.

Resolves audits/code-duplication-2026-05-14.md T-1, T-7.
```

## Optional follow-up

`GpuWarningDialog.svelte` uses different class names (`.backdrop`, `.dialog`) but the same shape. Fold it into the shared primitive in a separate small commit if you want — keep this phase scoped to the two with literal CSS duplication.
