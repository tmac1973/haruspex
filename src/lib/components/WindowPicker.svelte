<script lang="ts">
	/**
	 * The list of open windows to capture, on platforms without a picker of
	 * their own (macOS, Windows). Opens above the nearest positioned ancestor.
	 */
	import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';
	import { windowLabel } from '#lib/shell/captureWindow.ts';

	let {
		windows,
		onPick,
		onCancel
	}: {
		windows: CaptureWindow[];
		onPick: (id: number) => void;
		onCancel: () => void;
	} = $props();
</script>

<div class="window-picker" role="listbox" aria-label="Pick a window to capture">
	<div class="picker-head">
		<span>Capture which window?</span>
		<button class="picker-close" onclick={onCancel} aria-label="Cancel">×</button>
	</div>
	{#each windows as w (w.id)}
		<button class="picker-item" role="option" aria-selected="false" onclick={() => onPick(w.id)}
			>{windowLabel(w)}</button
		>
	{/each}
</div>

<style>
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
