<script lang="ts">
	/**
	 * A text editor for markdown and code: CodeMirror, loaded on first use.
	 *
	 * `value` is the starting text and any later replacement from outside (a
	 * different file opened); typing reports through `onchange` rather than
	 * writing back, so the parent decides what counts as saved.
	 */
	import { onMount } from 'svelte';
	import type { EditorHandle } from '#lib/editor/codemirror.ts';

	interface Props {
		value: string;
		onchange?: (value: string) => void;
		onsave?: () => void;
		readonly?: boolean;
		label?: string;
	}
	let { value, onchange, onsave, readonly = false, label = 'Editor' }: Props = $props();

	let host: HTMLDivElement;
	let editor = $state<EditorHandle | null>(null);
	let failed = $state('');

	onMount(() => {
		let gone = false;
		import('#lib/editor/codemirror.ts')
			.then(({ createEditor }) => {
				if (gone) return;
				editor = createEditor(host, {
					doc: value,
					readonly,
					onChange: (v) => onchange?.(v),
					onSave: () => onsave?.()
				});
				editor.focus();
			})
			.catch((e) => (failed = String(e)));
		return () => {
			gone = true;
			editor?.destroy();
		};
	});

	// A new `value` from outside replaces the text; the editor's own edits
	// already match it, so this only fires for a genuinely different document.
	$effect(() => {
		const next = value;
		if (editor && editor.getValue() !== next) editor.setValue(next);
	});
</script>

{#if failed}
	<p class="failed">The editor could not load: {failed}</p>
{/if}
<div class="code-editor" bind:this={host} role="group" aria-label={label}></div>

<style>
	.code-editor {
		height: 100%;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.failed {
		color: var(--danger, #ef4444);
		font-size: 0.85rem;
	}
</style>
