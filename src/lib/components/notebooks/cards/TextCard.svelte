<script lang="ts">
	/**
	 * A text card: markdown shown rendered, with clickable links. Edit opens
	 * it in a markdown editor; changes save a second after typing stops and
	 * when the editor loses focus.
	 */
	import { onDestroy } from 'svelte';
	import { renderMarkdown } from '#lib/markdown.ts';
	import { createEditor, type EditorHandle } from '#lib/editor/codemirror.ts';
	import { saveCard } from '#lib/stores/notebooks.svelte.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card, readonly = false }: CardViewProps = $props();

	let editing = $state(false);
	let host = $state<HTMLDivElement | null>(null);
	let editor: EditorHandle | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let draft = '';

	const html = $derived(renderMarkdown(card.body));

	async function flush() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (draft === card.body) return;
		const saved = await saveCard(card, { body: draft });
		// On a conflict the card reloads; the editor keeps the typing so it
		// can be copied back.
		if (saved && editor && editor.getValue() !== saved.body) draft = editor.getValue();
	}

	function startEditing() {
		if (readonly) return;
		editing = true;
	}

	$effect(() => {
		if (!editing || !host) return;
		draft = card.body;
		editor = createEditor(host, {
			path: 'card.md',
			doc: card.body,
			onChange(value) {
				draft = value;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => void flush(), 1000);
			},
			onSave: () => void flush()
		});
		editor.focus();
		return () => {
			editor?.destroy();
			editor = null;
		};
	});

	async function done() {
		await flush();
		editing = false;
	}

	onDestroy(() => {
		if (timer) {
			clearTimeout(timer);
			void flush();
		}
	});
</script>

{#if editing}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="editor"
		bind:this={host}
		onfocusout={(e) => {
			if (!host?.contains(e.relatedTarget as Node | null)) void flush();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				void done();
			}
		}}
	></div>
	<div class="actions">
		<button class="done" onclick={() => void done()}>Done</button>
	</div>
{:else if card.body.trim()}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="markdown view"
		class:readonly
		ondblclick={startEditing}
		title={readonly ? undefined : 'Double-click to edit'}
	>
		{@html html}
	</div>
	{#if !readonly}
		<div class="actions">
			<button class="link" onclick={startEditing}>Edit</button>
		</div>
	{/if}
{:else if !readonly}
	<button class="empty" onclick={startEditing}>Write something…</button>
{/if}

<style>
	.editor {
		min-height: 80px;
		max-height: 60vh;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.view {
		font-size: 0.92rem;
		line-height: 1.5;
		cursor: text;
	}

	.view.readonly {
		cursor: default;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}

	.done {
		padding: 4px 12px;
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.link,
	.empty {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 2px 4px;
	}

	.empty {
		font-size: 0.9rem;
		font-style: italic;
	}

	.link:hover,
	.empty:hover {
		color: var(--accent);
	}
</style>
