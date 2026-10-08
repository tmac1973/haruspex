<script lang="ts">
	/**
	 * Keyboard-shortcuts help: the list in `#lib/shortcuts.ts`, under a link
	 * to the online user guide. Keep the
	 * README's "Keyboard shortcuts" section in step with it too. Opened with F1 (global) or the header
	 * "?" button; closes on Esc, F1 again, the × button, or backdrop click
	 * (the last three via the shared Modal).
	 */
	import Modal from './Modal.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { SHORTCUTS } from '#lib/shortcuts.ts';
	import { GUIDE_URL } from '#lib/guide/prompt.ts';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();
</script>

<Modal
	{open}
	{onclose}
	dismissable
	title="Keyboard shortcuts"
	maxWidth={560}
	labelledBy="help-title"
>
	<p class="guide">
		The <button
			type="button"
			class="link"
			title={GUIDE_URL}
			onclick={() => void invoke('open_url', { url: GUIDE_URL }).catch(() => {})}>user guide</button
		> explains every feature and setting. You can also ask the assistant about Haruspex.
	</p>
	{#each SHORTCUTS as section (section.title)}
		<section>
			<h3>{section.title}</h3>
			<dl>
				{#each section.items as s (s.keys + s.action)}
					<div class="row">
						<dt><kbd>{s.keys}</kbd></dt>
						<dd>{s.action}</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/each}
</Modal>

<style>
	.guide {
		margin: 0 0 4px;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.link {
		padding: 0;
		border: none;
		background: none;
		color: var(--accent);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	section {
		margin-top: 14px;
	}

	section h3 {
		margin: 0 0 6px;
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-secondary);
	}

	dl {
		margin: 0;
	}

	.row {
		display: grid;
		grid-template-columns: 150px 1fr;
		gap: 12px;
		align-items: baseline;
		padding: 3px 0;
	}

	dt {
		margin: 0;
	}

	dd {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	kbd {
		display: inline-block;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		font-size: 0.72rem;
		color: var(--text-primary);
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 2px 7px;
		white-space: nowrap;
	}
</style>
