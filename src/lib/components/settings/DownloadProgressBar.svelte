<script lang="ts">
	import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
	import { formatBytes, formatBytesPerSecond } from '#lib/utils/format.ts';

	// One download's progress: a bar, what it is doing, how much and how fast.
	let {
		progress,
		oncancel
	}: {
		/** Null when the download was picked up after a reload and no event has arrived yet. */
		progress: DownloadProgress | null;
		oncancel?: () => void;
	} = $props();

	const pct = $derived(
		progress && progress.total > 0 ? Math.min(100, (progress.downloaded / progress.total) * 100) : 0
	);
	/** Checking a checksum reports bytes read, not bytes received: no speed. */
	const verifying = $derived(progress?.stage.startsWith('Verifying') ?? false);
</script>

<div class="download-inline">
	<div
		class="progress-mini"
		role="progressbar"
		aria-valuenow={Math.round(pct)}
		aria-valuemin={0}
		aria-valuemax={100}
	>
		<div class="progress-fill" style="width: {pct}%"></div>
	</div>
	<span class="progress-text">
		{#if !progress}
			Downloading…
		{:else}
			{progress.stage} · {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
			{#if !verifying && progress.speed_bps > 0}· {formatBytesPerSecond(progress.speed_bps)}{/if}
		{/if}
	</span>
	{#if oncancel}<button type="button" onclick={oncancel}>Cancel</button>{/if}
</div>

<style>
	.download-inline {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}
	.progress-mini {
		flex: 1;
		min-width: 120px;
		height: 6px;
		background: var(--border);
		border-radius: 3px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.2s;
	}
	.progress-text {
		font-size: 0.78rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}
</style>
