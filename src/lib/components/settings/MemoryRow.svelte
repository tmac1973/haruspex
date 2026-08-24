<script lang="ts">
	/**
	 * One remembered fact in the manager: what it says, where it came from,
	 * and the three things you can do about it.
	 *
	 * Delete has no confirmation. It is one row, the user is looking straight
	 * at its text, and the alternative — a modal per row — makes clearing out
	 * a handful of bad extractions tedious enough that people stop doing it.
	 * Clear-all is the destructive action that gets a confirm.
	 */
	import type { MemoryMeta } from '$lib/ipc/gen/MemoryMeta';

	interface Props {
		memory: MemoryMeta;
		onsave: (id: string, content: string) => Promise<void>;
		ondelete: (id: string) => Promise<void>;
	}

	const { memory, onsave, ondelete }: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let busy = $state(false);
	let copied = $state(false);

	function startEdit() {
		draft = memory.content;
		editing = true;
	}

	async function save() {
		const next = draft.trim();
		// An empty edit is a delete the user did not ask for; treat it as a
		// cancel rather than silently wiping the row's text.
		if (!next || next === memory.content) {
			editing = false;
			return;
		}
		busy = true;
		try {
			await onsave(memory.id, next);
			editing = false;
		} finally {
			busy = false;
		}
	}

	async function remove() {
		busy = true;
		try {
			await ondelete(memory.id);
		} finally {
			busy = false;
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(memory.content);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			// Clipboard can be unavailable in some webviews; the text is
			// selectable either way.
		}
	}

	function formatDate(ms: number): string {
		return new Date(ms).toLocaleDateString();
	}
</script>

<li class="memory-row">
	<div class="head">
		<span class="chip chip-{memory.category}">{memory.category}</span>
		<span class="meta">
			learned {formatDate(memory.created_at)}
			{#if memory.use_count > 0}
				· used {memory.use_count}×
			{/if}
			·
			{#if memory.source_title}
				from “{memory.source_title}”
			{:else}
				from a deleted chat
			{/if}
		</span>
	</div>

	{#if editing}
		<textarea bind:value={draft} rows="3" aria-label="Memory text"></textarea>
		<div class="actions">
			<button type="button" class="btn" onclick={save} disabled={busy}>
				{busy ? 'Saving…' : 'Save'}
			</button>
			<button type="button" class="link" onclick={() => (editing = false)} disabled={busy}>
				Cancel
			</button>
		</div>
	{:else}
		<p class="content">{memory.content}</p>
		<div class="actions">
			<button type="button" class="link" onclick={startEdit} disabled={busy}>Edit</button>
			<button type="button" class="link" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
			<button type="button" class="link danger" onclick={remove} disabled={busy}>Delete</button>
		</div>
	{/if}
</li>

<style>
	.memory-row {
		list-style: none;
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.chip {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 6px;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}

	.chip-preference,
	.chip-correction {
		border-color: var(--accent);
		color: var(--accent);
	}

	.meta {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.content {
		margin: 6px 0 4px;
		line-height: 1.45;
	}

	textarea {
		width: 100%;
		margin: 6px 0 4px;
		resize: vertical;
	}

	.actions {
		display: flex;
		gap: 12px;
		align-items: center;
	}

	.danger {
		color: var(--error, #d66);
	}
</style>
