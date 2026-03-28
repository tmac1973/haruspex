<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { startServer, stopServer, getServerState } from '$lib/stores/server.svelte';
	import { getSettings, updateSettings, type ResponseFormat } from '$lib/stores/settings';

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
	}

	let models = $state<ModelInfo[]>([]);
	let activeModelPath = $state<string | null>(null);
	let downloading = $state<string | null>(null);
	let downloadProgress = $state<DownloadProgress | null>(null);
	let downloadError = $state<string | null>(null);
	let modelsDir = $state('');
	const serverState = $derived(getServerState());
	let responseFormat = $state<ResponseFormat>(getSettings().responseFormat);

	function setResponseFormat(format: ResponseFormat) {
		responseFormat = format;
		updateSettings({ responseFormat: format });
	}

	onMount(async () => {
		await refreshModels();
		modelsDir = await invoke<string>('get_models_dir');
	});

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
		downloadProgress = { downloaded: 0, total: 0, speed_bps: 0 };
		downloadError = null;

		const unlisten = await listen<DownloadProgress>('download-progress', (event) => {
			downloadProgress = event.payload;
		});

		try {
			await invoke('download_model', { modelId });
			unlisten();
			downloading = null;
			downloadProgress = null;
			await refreshModels();
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
		await stopServer();
		await startServer(path);
	}

	async function cancelDownload() {
		await invoke('cancel_download');
		downloading = null;
		downloadProgress = null;
	}
</script>

<div class="settings">
	<div class="settings-header">
		<button class="back-btn" onclick={() => goto('/')}>&#8592; Back</button>
		<h1>Settings</h1>
	</div>

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
										{formatBytes(downloadProgress.downloaded)} / {formatBytes(
											downloadProgress.total
										)}
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

	<section>
		<h2>Response Format</h2>
		<div class="format-options">
			<label class="format-option" class:selected={responseFormat === 'minimal'}>
				<input
					type="radio"
					name="format"
					value="minimal"
					checked={responseFormat === 'minimal'}
					onchange={() => setResponseFormat('minimal')}
				/>
				<div>
					<strong>Minimal</strong>
					<span>Plain text, no formatting or emojis</span>
				</div>
			</label>
			<label class="format-option" class:selected={responseFormat === 'standard'}>
				<input
					type="radio"
					name="format"
					value="standard"
					checked={responseFormat === 'standard'}
					onchange={() => setResponseFormat('standard')}
				/>
				<div>
					<strong>Standard</strong>
					<span>Clean markdown (headings, lists, code blocks)</span>
				</div>
			</label>
			<label class="format-option" class:selected={responseFormat === 'rich'}>
				<input
					type="radio"
					name="format"
					value="rich"
					checked={responseFormat === 'rich'}
					onchange={() => setResponseFormat('rich')}
				/>
				<div>
					<strong>Rich</strong>
					<span>Full markdown with tables and emojis</span>
				</div>
			</label>
		</div>
	</section>

	<section>
		<h2>Server</h2>
		<div class="info-row">
			<span>Status</span>
			<span class="status-value" data-status={serverState.status}>{serverState.status}</span>
		</div>
		<div class="info-row">
			<span>Port</span>
			<span>8765</span>
		</div>
	</section>
</div>

<style>
	.settings {
		max-width: 640px;
		margin: 0 auto;
		padding: 24px;
	}

	.settings-header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 24px;
	}

	.settings-header h1 {
		margin: 0;
		font-size: 1.3rem;
	}

	.back-btn {
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 12px;
		cursor: pointer;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.back-btn:hover {
		background: var(--bg-secondary);
	}

	section {
		margin-bottom: 32px;
	}

	h2 {
		font-size: 1rem;
		margin: 0 0 8px 0;
		color: var(--text-primary);
	}

	.hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin: 0 0 16px 0;
	}

	.hint code {
		background: var(--bg-secondary);
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 0.75rem;
	}

	.model-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.model-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		gap: 12px;
	}

	.model-card.active {
		border-color: var(--accent);
	}

	.model-info {
		flex: 1;
		min-width: 0;
	}

	.model-name {
		font-weight: 600;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.active-badge {
		font-size: 0.65rem;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--accent);
		color: white;
		text-transform: uppercase;
	}

	.model-desc {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.model-size {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.model-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.btn-danger {
		color: var(--error-text);
		border-color: var(--error-border);
	}

	.btn-danger:hover {
		background: var(--error-bg);
	}

	.btn-small {
		padding: 3px 10px;
		font-size: 0.75rem;
	}

	.download-inline {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.progress-mini {
		width: 80px;
		height: 4px;
		background: var(--bg-secondary);
		border-radius: 2px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.3s ease;
	}

	.progress-text {
		white-space: nowrap;
	}

	.error-box {
		margin-top: 12px;
		padding: 10px 14px;
		background: var(--error-bg);
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.format-options {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.format-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.format-option:hover {
		border-color: var(--text-secondary);
	}

	.format-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.format-option input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.format-option strong {
		display: block;
		font-size: 0.9rem;
	}

	.format-option span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		font-size: 0.9rem;
	}

	.status-value[data-status='ready'] {
		color: #22c55e;
	}
	.status-value[data-status='starting'] {
		color: #eab308;
	}
	.status-value[data-status='error'] {
		color: var(--error-text);
	}
	.status-value[data-status='stopped'] {
		color: var(--text-secondary);
	}
</style>
