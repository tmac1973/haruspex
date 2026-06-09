<script lang="ts">
	/**
	 * Keyboard-shortcuts help. Single source of truth for the app's hotkeys —
	 * keep `SECTIONS` in sync when a binding changes (and the README's
	 * "Keyboard shortcuts" section). Opened with F1 (global) or the header
	 * "?" button; closes on Esc, F1 again, the × button, or backdrop click
	 * (the last three via the shared Modal).
	 */
	import Modal from './Modal.svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();

	interface Shortcut {
		keys: string;
		action: string;
	}
	interface Section {
		title: string;
		items: Shortcut[];
	}

	const SECTIONS: Section[] = [
		{
			title: 'Global',
			items: [
				{ keys: 'F1', action: 'Show this shortcuts help' },
				{ keys: 'F2 (hold)', action: 'Push-to-talk — voice input, release to send' },
				{ keys: 'F3', action: 'Read the last reply aloud (toggle)' },
				{ keys: 'Ctrl / ⌘ + N', action: 'New conversation (Chat tab)' }
			]
		},
		{
			title: 'Chat',
			items: [
				{ keys: 'Enter', action: 'Send message' },
				{ keys: 'Shift + Enter', action: 'New line' },
				{ keys: 'Esc', action: 'Stop generating' }
			]
		},
		{
			title: 'Shell tab',
			items: [
				{
					keys: 'F4',
					action: 'Submit recent shell commands & output to the assistant (no prompt)'
				},
				{ keys: 'Ctrl + Shift + A', action: 'Toggle the assistant sidebar' },
				{ keys: 'Ctrl + `', action: 'Switch focus: terminal ↔ assistant' },
				{ keys: 'Ctrl + Shift + C', action: 'Copy terminal selection' },
				{ keys: 'Ctrl + Shift + V', action: 'Paste into terminal' },
				{ keys: 'Enter', action: 'Send to assistant (Shift + Enter for new line)' },
				{ keys: 'Esc', action: 'Stop the assistant' }
			]
		},
		{
			title: 'Dialogs',
			items: [{ keys: 'Esc', action: 'Close logs, the image viewer, or this help' }]
		}
	];
</script>

<Modal
	{open}
	{onclose}
	dismissable
	title="Keyboard shortcuts"
	maxWidth={560}
	labelledBy="help-title"
>
	{#each SECTIONS as section (section.title)}
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
