<script lang="ts">
	/**
	 * Keyboard-shortcuts help. Single source of truth for the app's hotkeys —
	 * keep `SECTIONS` in sync when a binding changes (and the README's
	 * "Keyboard shortcuts" section). Opened with F1 (global) or the header
	 * "?" button; closes on Esc, F1 again, or the close button.
	 */
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

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="help-backdrop">
		<div class="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title">
			<div class="help-head">
				<h2 id="help-title">Keyboard shortcuts</h2>
				<button class="help-close" onclick={onclose} aria-label="Close help">×</button>
			</div>
			<div class="help-body">
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
			</div>
		</div>
	</div>
{/if}

<style>
	.help-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}

	.help-modal {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 12px;
		width: 100%;
		max-width: 560px;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
	}

	.help-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 18px 24px 12px;
		border-bottom: 1px solid var(--border);
	}

	.help-head h2 {
		margin: 0;
		font-size: 1.15rem;
		color: var(--text-primary);
	}

	.help-close {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.4rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
		border-radius: 4px;
	}

	.help-close:hover {
		color: var(--text-primary);
	}

	.help-body {
		padding: 8px 24px 20px;
		overflow-y: auto;
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
