<script lang="ts">
	/**
	 * Model catalog card. Lists every model in the registry with a
	 * Download / Use / Delete action and shows live download progress.
	 * Only mounted in local-inference mode; in remote mode no local
	 * llama-server runs and the catalog is irrelevant.
	 *
	 * State that needs to survive an active download (downloading id,
	 * progress, error) lives inside this component. The active model
	 * path is queried fresh from Rust on each refresh — the route also
	 * caches it for the Server card, but that's a separate
	 * `get_active_model_path` call on its own card.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { downloadModelWithProgress } from '$lib/models/download';
	import { onMount } from 'svelte';
	import { restartServerWhenIdle, stopServer } from '$lib/stores/server.svelte';
	import {
		getActiveLocalModelFilename,
		getLegacyModelNoticeDismissed,
		getSettings,
		setActiveLocalModel,
		setLegacyModelNoticeDismissed
	} from '$lib/stores/settings';
	import { formatBytes, formatBytesPerSecond } from '$lib/utils/format';
	import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';
	import type { ModelInfo } from '$lib/ipc/gen/ModelInfo';

	let models = $state<ModelInfo[]>([]);
	let activeModelPath = $state<string | null>(null);
	let downloading = $state<string | null>(null);
	let downloadProgress = $state<DownloadProgress | null>(null);
	let downloadError = $state<string | null>(null);
	let modelsDir = $state('');
	// Whether the "show retired models" section is expanded. Legacy models
	// the user still has on disk show regardless; this reveals the rest
	// (so a deleted legacy model can still be re-downloaded).
	let showLegacy = $state(false);
	let noticeDismissed = $state(getLegacyModelNoticeDismissed());

	const activeFilename = $derived(
		activeModelPath ? activeModelPath.split('/').pop() || null : null
	);
	const currentModels = $derived(models.filter((m) => !m.legacy));
	const legacyModels = $derived(models.filter((m) => m.legacy));
	const downloadedLegacy = $derived(legacyModels.filter((m) => m.downloaded));
	const visibleLegacy = $derived(showLegacy ? legacyModels : downloadedLegacy);
	const hiddenLegacyCount = $derived(legacyModels.length - downloadedLegacy.length);
	// The active model is one that's been retired from the lineup.
	const activeIsLegacy = $derived(legacyModels.some((m) => m.filename === activeFilename));
	const showLegacyNotice = $derived(activeIsLegacy && !noticeDismissed);

	async function refreshModels() {
		models = await invoke<ModelInfo[]>('list_models');
		// Pass the user's persisted choice so the "active" badge tracks
		// what they actually picked, not whichever .gguf the OS happens
		// to enumerate first from the models dir.
		activeModelPath = await invoke<string | null>('get_active_model_path', {
			preferredFilename: getActiveLocalModelFilename() || null
		});
	}

	function activeModelFilename(): string | null {
		return activeFilename;
	}

	function dismissNotice() {
		noticeDismissed = true;
		setLegacyModelNoticeDismissed(true);
	}

	async function downloadModel(modelId: string) {
		downloading = modelId;
		downloadProgress = { downloaded: 0, total: 0, speed_bps: 0, stage: 'Starting...' };
		downloadError = null;

		try {
			const modelPath = await downloadModelWithProgress(modelId, (p) => (downloadProgress = p));
			downloading = null;
			downloadProgress = null;
			await refreshModels();
			// Auto-start server with the newly downloaded model
			await switchModel(modelPath.split('/').pop()!);
		} catch (e) {
			downloading = null;
			downloadProgress = null;
			downloadError = String(e);
		}
	}

	async function removeModel(filename: string) {
		const isActive = activeModelFilename() === filename;
		if (isActive) {
			await stopServer();
		}
		await invoke('delete_model', { filename });
		await refreshModels();
	}

	async function switchModel(filename: string) {
		const path = `${modelsDir}/${filename}`;
		setActiveLocalModel(path);
		activeModelPath = path;
		// Restart onto the new model — but if a turn is in flight, defer it
		// rather than aborting the response. The "restart queued" banner in
		// InferenceSection then shows it's waiting for inference to finish.
		await restartServerWhenIdle(path, getSettings().contextSize, 'model');
	}

	async function cancelDownload() {
		await invoke('cancel_download');
		downloading = null;
		downloadProgress = null;
	}

	onMount(async () => {
		await refreshModels();
		modelsDir = await invoke<string>('get_models_dir');
	});
</script>

{#snippet modelCard(model: ModelInfo)}
	<div class="model-card" class:active={activeModelFilename() === model.filename}>
		<div class="model-card-row">
			<div class="model-info">
				<div class="model-name">
					{model.id}
					{#if activeModelFilename() === model.filename}
						<span class="active-badge">active</span>
					{/if}
					{#if model.legacy}
						<span class="legacy-badge">legacy</span>
					{/if}
				</div>
				<div class="model-desc">{model.description}</div>
				<div class="model-size">{formatBytes(model.size_bytes)}</div>
			</div>
			<div class="model-actions">
				{#if model.downloaded}
					{#if activeModelFilename() !== model.filename}
						<button class="btn btn-primary" onclick={() => switchModel(model.filename)}>
							Use
						</button>
					{/if}
					<button
						class="btn btn-danger"
						onclick={() => removeModel(model.filename)}
						title={model.legacy
							? 'Delete this legacy model file (you can re-download it later)'
							: 'Delete model file'}
					>
						Delete
					</button>
				{:else if downloading === model.id}
					<button class="btn btn-small" onclick={cancelDownload}>Cancel</button>
				{:else}
					<button
						class="btn btn-primary"
						onclick={() => downloadModel(model.id)}
						disabled={downloading !== null}
					>
						Download
					</button>
				{/if}
			</div>
		</div>
		{#if downloading === model.id && downloadProgress}
			<div class="download-inline">
				<div class="progress-mini">
					<div
						class="progress-fill"
						style="width: {downloadProgress.total > 0
							? (downloadProgress.downloaded / downloadProgress.total) * 100
							: 0}%"
					></div>
				</div>
				<span class="progress-text">
					{#if downloadProgress.stage}{downloadProgress.stage} &middot;
					{/if}{formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
					&middot; {formatBytesPerSecond(downloadProgress.speed_bps)}
				</span>
			</div>
		{/if}
	</div>
{/snippet}

<section>
	<h2>Models</h2>
	<p class="hint">Models are stored in: <code>{modelsDir}</code></p>

	{#if showLegacyNotice}
		<div class="notice-box">
			<div class="notice-text">
				<strong>The recommended models have changed.</strong>
				Your current model is now a legacy choice — it still works, but newer Unsloth dynamic quants are
				recommended above. Pick one to try it; you can switch back to your legacy model anytime below.
			</div>
			<button class="btn btn-small" onclick={dismissNotice}>Dismiss</button>
		</div>
	{/if}

	<div class="model-list">
		{#each currentModels as model (model.id)}
			{@render modelCard(model)}
		{/each}
	</div>

	{#if legacyModels.length > 0}
		<div class="legacy-section">
			<div class="legacy-header">
				<span class="legacy-title">Legacy models</span>
				{#if hiddenLegacyCount > 0}
					<button class="btn btn-small" onclick={() => (showLegacy = !showLegacy)}>
						{showLegacy ? 'Hide' : `Show ${hiddenLegacyCount} more`}
					</button>
				{/if}
			</div>
			<p class="hint">
				Retired from the recommended lineup. Kept so you can keep using one you already have or
				re-download it; not suggested for new setups.
			</p>
			<div class="model-list">
				{#each visibleLegacy as model (model.id)}
					{@render modelCard(model)}
				{/each}
			</div>
		</div>
	{/if}

	{#if downloadError}
		<div class="error-box">{downloadError}</div>
	{/if}
</section>

<style>
	section {
		margin-bottom: 32px;
	}
	h2 {
		margin: 0 0 12px 0;
		font-size: 1.1rem;
		color: var(--text-primary);
	}
	.hint {
		margin: 0 0 12px 0;
	}
	code {
		background: var(--bg-secondary);
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 0.8rem;
	}
	.model-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.model-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border-radius: 8px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
	}
	.model-card-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.model-card.active {
		border-color: var(--accent);
	}
	.model-info {
		flex: 1;
	}
	.model-name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 500;
		color: var(--text-primary);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.9rem;
	}
	.active-badge {
		font-size: 0.7rem;
		background: var(--accent);
		color: white;
		padding: 2px 6px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.legacy-badge {
		font-size: 0.7rem;
		background: var(--bg-primary);
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 2px 6px;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.notice-box {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 16px;
		padding: 12px 14px;
		background: var(--bg-secondary);
		border: 1px solid var(--accent);
		border-radius: 8px;
	}
	.notice-text {
		flex: 1;
		font-size: 0.85rem;
		color: var(--text-secondary);
		line-height: 1.5;
	}
	.notice-text strong {
		color: var(--text-primary);
	}
	.legacy-section {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.legacy-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.legacy-title {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text-primary);
	}
	.legacy-section .hint {
		margin-top: 6px;
	}
	.model-desc {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-top: 4px;
	}
	.model-size {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-top: 4px;
	}
	.model-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.download-inline {
		display: flex;
		align-items: center;
		gap: 10px;
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
	/* Spacing override of the global .error-box. */
	.error-box {
		margin-top: 12px;
	}
</style>
