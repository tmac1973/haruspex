<script lang="ts">
	/**
	 * The camera button: pick a window and hand back a screenshot of it. Shell
	 * sends it at once; Code attaches it to the message being written.
	 *
	 * On Linux the desktop portal shows its own picker. macOS and Windows have
	 * none, so a list of open windows opens above the composer (the nearest
	 * positioned ancestor). A person pressing a button is not the Settings →
	 * Screen question, which is about the assistant asking.
	 */
	import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';
	import { captureWindowImage, windowLabel, windowsToPick } from '#lib/shell/captureWindow.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		onCapture,
		disabled = false,
		title,
		label
	}: {
		onCapture: (dataUrl: string) => void | Promise<void>;
		disabled?: boolean;
		title: string;
		label: string;
	} = $props();

	let capturing = $state(false);
	/** The pick list, on platforms without a picker of their own. */
	let windowChoices = $state<CaptureWindow[] | null>(null);

	async function start() {
		if (capturing || disabled) return;
		capturing = true;
		try {
			const windows = await windowsToPick();
			if (windows.length === 0) await capture(null);
			else windowChoices = windows;
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		} finally {
			capturing = false;
		}
	}

	async function capture(id: number | null) {
		windowChoices = null;
		capturing = true;
		try {
			await onCapture(await captureWindowImage(id));
		} catch (e) {
			// Cancelling the desktop's own picker lands here too: a decision,
			// said plainly, not an error to dig into.
			showToast(errMessage(e), { kind: 'error' });
		} finally {
			capturing = false;
		}
	}
</script>

{#if windowChoices}
	<div class="window-picker" role="listbox" aria-label="Pick a window to capture">
		<div class="picker-head">
			<span>Capture which window?</span>
			<button class="picker-close" onclick={() => (windowChoices = null)} aria-label="Cancel"
				>×</button
			>
		</div>
		{#each windowChoices as w (w.id)}
			<button class="picker-item" role="option" aria-selected="false" onclick={() => capture(w.id)}
				>{windowLabel(w)}</button
			>
		{/each}
	</div>
{/if}
<button
	class="capture-btn"
	onclick={start}
	disabled={disabled || capturing}
	{title}
	aria-label={label}
>
	<svg
		width="18"
		height="18"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
		></path>
		<circle cx="12" cy="13" r="4"></circle>
	</svg>
</button>

<style>
	.capture-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.capture-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.capture-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.window-picker {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: calc(100% + 4px);
		z-index: 10;
		display: flex;
		flex-direction: column;
		max-height: 220px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
	}

	.picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 8px;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.picker-close {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1rem;
	}

	.picker-item {
		text-align: left;
		padding: 6px 8px;
		border: none;
		border-top: 1px solid var(--border);
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.picker-item:hover {
		background: var(--bg-primary);
	}
</style>
