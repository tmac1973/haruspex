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
	import { listen } from '@tauri-apps/api/event';
	import { onMount } from 'svelte';
	import { startServer, stopServer } from '$lib/stores/server.svelte';
	import { getSettings, setActiveLocalModel } from '$lib/stores/settings';

	interface ModelInfo {
		id: string;
		filename: string;
		url: string;
		size_bytes: number;
		description: string;
		downloaded: boolean;
	}

	interface DownloadProgress {
		downloaded: number;
		total: number;
		speed_bps: number;
		stage: string;
	}

	let models = $state<ModelInfo[]>([]);
	let activeModelPath = $state<string | null>(null);
	let downloading = $state<string | null>(null);
	let downloadProgress = $state<DownloadProgress | null>(null);
	let downloadError = $state<string | null>(null);
	let modelsDir = $state('');

	async function refreshModels() {
		models = await invoke<ModelInfo[]>('list_models');
		activeModelPath = await invoke<string | null>('get_active_model_path');
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MB`;
		return `${(bytes / 1073741824).toFixed(1)} GB`;
	}

	function formatSpeed(bps: number): string {
		if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`;
		return `${(bps / 1048576).toFixed(1)} MB/s`;
	}

	function activeModelFilename(): string | null {
		if (!activeModelPath) return null;
		return activeModelPath.split('/').pop() || null;
	}

	async function downloadModel(modelId: string) {
		downloading = modelId;
		downloadProgress = { downloaded: 0, total: 0, speed_bps: 0, stage: 'Starting...' };
		downloadError = null;

		const unlisten = await listen<DownloadProgress>('download-progress', (event) => {
			downloadProgress = event.payload;
		});

		try {
			const modelPath = await invoke<string>('download_model', { modelId });
			unlisten();
			downloading = null;
			downloadProgress = null;
			await refreshModels();
			// Auto-start server with the newly downloaded model
			await switchModel(modelPath.split('/').pop()!);
		} catch (e) {
			unlisten();
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
		await stopServer();
		await startServer(path, getSettings().contextSize);
		activeModelPath = path;
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

<section>
	<h2>Models</h2>
	<p class="hint">Models are stored in: <code>{modelsDir}</code></p>

	<div class="model-list">
		{#each models as model (model.id)}
			<div class="model-card" class:active={activeModelFilename() === model.filename}>
				<div class="model-info">
					<div class="model-name">
						{model.id}
						{#if activeModelFilename() === model.filename}
							<span class="active-badge">active</span>
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
							title="Delete model file"
						>
							Delete
						</button>
					{:else if downloading === model.id}
						{#if downloadProgress}
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
									{formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
									&middot; {formatSpeed(downloadProgress.speed_bps)}
								</span>
								<button class="btn btn-small" onclick={cancelDownload}>Cancel</button>
							</div>
						{/if}
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
		{/each}
	</div>

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
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0 0 12px 0;
		line-height: 1.5;
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
		justify-content: space-between;
		align-items: center;
		padding: 16px;
		border-radius: 8px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
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
	.btn {
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) {
		background: var(--bg-secondary);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-primary {
		background: var(--accent);
		border-color: var(--accent);
		color: white;
	}
	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
		background: var(--accent);
	}
	.btn-danger {
		color: #ef4444;
		border-color: #ef4444;
	}
	.btn-danger:hover {
		background: #ef4444;
		color: white;
	}
	.btn-small {
		padding: 4px 10px;
		font-size: 0.8rem;
	}
	.download-inline {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.progress-mini {
		width: 140px;
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
	.error-box {
		margin-top: 12px;
		padding: 12px;
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.3);
		border-radius: 6px;
		color: #ef4444;
		font-size: 0.85rem;
	}
</style>
