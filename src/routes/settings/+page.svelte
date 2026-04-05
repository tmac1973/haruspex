<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { startServer, stopServer, getServerState } from '$lib/stores/server.svelte';
	import {
		getSettings,
		updateSettings,
		applyTheme,
		type ResponseFormat,
		type ThemeMode,
		type SearchProvider,
		type AppSettings
	} from '$lib/stores/settings';

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
	const serverState = $derived(getServerState());
	let responseFormat = $state<ResponseFormat>(getSettings().responseFormat);
	let theme = $state<ThemeMode>(getSettings().theme);
	let ttsVoice = $state(getSettings().ttsVoice);

	const voiceOptions = [
		{ id: 'af_heart', name: 'Heart (Female)' },
		{ id: 'af_sky', name: 'Sky (Female)' },
		{ id: 'af_nicole', name: 'Nicole (Female)' },
		{ id: 'af_bella', name: 'Bella (Female)' },
		{ id: 'af_nova', name: 'Nova (Female)' },
		{ id: 'af_sarah', name: 'Sarah (Female)' },
		{ id: 'af_alloy', name: 'Alloy (Female)' },
		{ id: 'af_river', name: 'River (Female)' },
		{ id: 'am_adam', name: 'Adam (Male)' },
		{ id: 'am_michael', name: 'Michael (Male)' },
		{ id: 'am_echo', name: 'Echo (Male)' },
		{ id: 'am_eric', name: 'Eric (Male)' },
		{ id: 'am_liam', name: 'Liam (Male)' },
		{ id: 'ef_dora', name: 'Dora (European Female)' },
		{ id: 'em_alex', name: 'Alex (European Male)' }
	];

	let searchProvider = $state<SearchProvider>(getSettings().searchProvider);
	let searchRecency = $state(getSettings().searchRecency);
	let braveApiKey = $state(getSettings().braveApiKey);
	let searxngUrl = $state(getSettings().searxngUrl);
	let contextSize = $state(getSettings().contextSize);

	function setTtsVoice(voice: string) {
		ttsVoice = voice;
		updateSettings({ ttsVoice: voice });
	}

	let ttsReadTablesByColumn = $state(getSettings().ttsReadTablesByColumn);

	function toggleTableReading() {
		ttsReadTablesByColumn = !ttsReadTablesByColumn;
		updateSettings({ ttsReadTablesByColumn });
	}

	function setSearchProvider(provider: SearchProvider) {
		searchProvider = provider;
		updateSettings({ searchProvider: provider });
	}

	function saveBraveKey() {
		updateSettings({ braveApiKey: braveApiKey });
	}

	function saveSearxngUrl() {
		updateSettings({ searxngUrl: searxngUrl });
	}

	function setSearchRecency(value: string) {
		searchRecency = value as AppSettings['searchRecency'];
		updateSettings({ searchRecency: searchRecency });
	}

	function setContextSize(size: number) {
		contextSize = size;
		updateSettings({ contextSize: size });
	}

	function setResponseFormat(format: ResponseFormat) {
		responseFormat = format;
		updateSettings({ responseFormat: format });
	}

	function setTheme(mode: ThemeMode) {
		theme = mode;
		updateSettings({ theme: mode });
		applyTheme(mode);
	}

	let outputDevices = $state<string[]>(['System Default']);
	let inputDevices = $state<string[]>(['System Default']);
	let audioOutputDevice = $state(getSettings().audioOutputDevice || 'System Default');
	let audioInputDevice = $state(getSettings().audioInputDevice || 'System Default');

	async function refreshOutputDevices() {
		try {
			outputDevices = await invoke<string[]>('list_audio_output_devices');
		} catch {
			// ignore
		}
	}

	async function refreshInputDevices() {
		try {
			inputDevices = await invoke<string[]>('list_audio_input_devices');
		} catch {
			// ignore
		}
	}

	function setOutputDevice(device: string) {
		audioOutputDevice = device;
		updateSettings({ audioOutputDevice: device === 'System Default' ? '' : device });
	}

	function setInputDevice(device: string) {
		audioInputDevice = device;
		updateSettings({ audioInputDevice: device === 'System Default' ? '' : device });
	}

	onMount(async () => {
		await refreshModels();
		modelsDir = await invoke<string>('get_models_dir');
		refreshOutputDevices();
		refreshInputDevices();
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
		await stopServer();
		await startServer(path);
		activeModelPath = path;
	}

	async function restartServer() {
		const modelPath = await invoke<string | null>('get_active_model_path');
		if (modelPath) {
			await stopServer();
			await startServer(modelPath, getSettings().contextSize);
			// Re-initialize TTS alongside
			invoke('tts_initialize').catch(() => {});
		}
	}

	async function cancelDownload() {
		await invoke('cancel_download');
		downloading = null;
		downloadProgress = null;
	}
</script>

<div class="settings-header">
	<button class="back-btn" onclick={() => goto('/')}>&#8592; Back</button>
	<h1>Settings</h1>
</div>

<div class="settings">
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
		<h2>Theme</h2>
		<div class="theme-options">
			{#each [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as opt (opt.value)}
				<button
					class="theme-btn"
					class:selected={theme === opt.value}
					onclick={() => setTheme(opt.value as ThemeMode)}
				>
					{opt.label}
				</button>
			{/each}
		</div>
	</section>

	<section>
		<h2>Voice</h2>
		<div class="voice-select">
			<label for="tts-voice">Text-to-speech voice:</label>
			<select
				id="tts-voice"
				value={ttsVoice}
				onchange={(e) => setTtsVoice((e.target as HTMLSelectElement).value)}
			>
				{#each voiceOptions as voice (voice.id)}
					<option value={voice.id}>{voice.name}</option>
				{/each}
			</select>
		</div>
		<label class="toggle-row">
			<input type="checkbox" checked={ttsReadTablesByColumn} onchange={toggleTableReading} />
			<div>
				<strong>Read tables by subject</strong>
				<span>Read all data for each column subject, instead of row by row</span>
			</div>
		</label>
		<p class="hint">Click the speaker icon on any assistant message to hear it read aloud.</p>
	</section>

	<section>
		<h2>Audio Devices</h2>
		<div class="device-select">
			<label for="output-device">Audio output (TTS playback):</label>
			<div class="device-row">
				<select
					id="output-device"
					value={audioOutputDevice}
					onchange={(e) => setOutputDevice((e.target as HTMLSelectElement).value)}
				>
					{#each outputDevices as device (device)}
						<option value={device}>{device}</option>
					{/each}
				</select>
				<button class="btn btn-small" onclick={refreshOutputDevices}>Refresh</button>
			</div>
		</div>
		<div class="device-select">
			<label for="input-device">Audio input (microphone):</label>
			<div class="device-row">
				<select
					id="input-device"
					value={audioInputDevice}
					onchange={(e) => setInputDevice((e.target as HTMLSelectElement).value)}
				>
					{#each inputDevices as device (device)}
						<option value={device}>{device}</option>
					{/each}
				</select>
				<button class="btn btn-small" onclick={refreshInputDevices}>Refresh</button>
			</div>
		</div>
		<p class="hint">Select audio devices or use "System Default" to follow OS settings.</p>
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
		<h2>Web Search</h2>
		<div class="search-provider">
			<label for="search-provider">Search provider:</label>
			<select
				id="search-provider"
				value={searchProvider}
				onchange={(e) => setSearchProvider((e.target as HTMLSelectElement).value as SearchProvider)}
			>
				<option value="auto">Auto (rotates free engines)</option>
				<option value="duckduckgo">DuckDuckGo (no key needed)</option>
				<option value="brave">Brave Search (API key required)</option>
				<option value="searxng">SearXNG (self-hosted)</option>
			</select>
		</div>

		{#if searchProvider === 'brave'}
			<div class="search-field">
				<label for="brave-key">Brave API Key:</label>
				<input
					id="brave-key"
					type="password"
					bind:value={braveApiKey}
					onblur={saveBraveKey}
					placeholder="BSA..."
				/>
				<p class="hint">Get a free key at brave.com/search/api (2,000 queries/month)</p>
			</div>
		{/if}

		{#if searchProvider === 'searxng'}
			<div class="search-field">
				<label for="searxng-url">SearXNG Instance URL:</label>
				<input
					id="searxng-url"
					type="text"
					bind:value={searxngUrl}
					onblur={saveSearxngUrl}
					placeholder="http://localhost:8080"
				/>
			</div>
		{/if}

		<div class="search-provider" style="margin-top: 12px">
			<label for="search-recency">Result recency:</label>
			<select
				id="search-recency"
				value={searchRecency}
				onchange={(e) => setSearchRecency((e.target as HTMLSelectElement).value)}
			>
				<option value="any">Any time</option>
				<option value="day">Past 24 hours</option>
				<option value="week">Past week</option>
				<option value="month">Past month</option>
				<option value="year">Past year</option>
			</select>
		</div>
	</section>

	<section>
		<h2>Context Size</h2>
		<p class="hint">
			Larger context allows longer conversations but uses more VRAM. Requires server restart to take
			effect.
		</p>
		<div class="context-options">
			{#each [{ value: 8192, label: '8K', desc: 'Low VRAM' }, { value: 16384, label: '16K', desc: 'Standard' }, { value: 32768, label: '32K', desc: 'Recommended' }, { value: 65536, label: '64K', desc: '16+ GB VRAM' }, { value: 131072, label: '128K', desc: 'Maximum' }] as opt (opt.value)}
				<button
					class="ctx-btn"
					class:selected={contextSize === opt.value}
					onclick={() => setContextSize(opt.value)}
				>
					<strong>{opt.label}</strong>
					<span>{opt.desc}</span>
				</button>
			{/each}
		</div>
		{#if contextSize !== getSettings().contextSize}
			<p class="hint" style="color: var(--accent)">
				Restart the server for the new context size to take effect.
			</p>
		{/if}
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
		<div class="server-actions">
			{#if serverState.status === 'ready' || serverState.status === 'error'}
				<button class="btn btn-primary" onclick={restartServer}>Restart Server</button>
			{:else if serverState.status === 'stopped'}
				<button class="btn btn-primary" onclick={restartServer}>Start Server</button>
			{:else}
				<button class="btn" disabled>Starting...</button>
			{/if}
			{#if serverState.status === 'ready' || serverState.status === 'starting'}
				<button class="btn btn-danger" onclick={() => stopServer()}>Stop Server</button>
			{/if}
		</div>
	</section>
</div>

<style>
	.settings-header {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 12px 24px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.settings-header h1 {
		margin: 0;
		font-size: 1.3rem;
	}

	.settings {
		max-width: 640px;
		margin: 0 auto;
		padding: 24px 24px 64px;
		height: calc(100vh - 45px - 50px);
		overflow-y: auto;
	}

	section {
		padding-bottom: 24px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--border);
	}

	section:last-child {
		border-bottom: none;
		margin-bottom: 0;
		padding-bottom: 64px;
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

	.search-provider {
		margin-bottom: 12px;
	}

	.search-provider label,
	.search-field label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.search-provider select,
	.search-field input {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.search-provider select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.search-field {
		margin-bottom: 12px;
	}

	.context-options {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.ctx-btn {
		flex: 1;
		min-width: 80px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		text-align: center;
	}

	.ctx-btn:hover {
		border-color: var(--text-secondary);
	}

	.ctx-btn.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.ctx-btn strong {
		display: block;
		font-size: 0.95rem;
	}

	.ctx-btn span {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.toggle-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 0;
		cursor: pointer;
	}

	.toggle-row input[type='checkbox'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.toggle-row strong {
		display: block;
		font-size: 0.9rem;
	}

	.toggle-row span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.voice-select {
		margin-bottom: 8px;
	}

	.voice-select label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.voice-select select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.voice-select select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.device-select {
		margin-bottom: 12px;
	}

	.device-select label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.device-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.device-row select {
		flex: 1;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.device-row select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.theme-options {
		display: flex;
		gap: 8px;
	}

	.theme-btn {
		flex: 1;
		padding: 8px 16px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.theme-btn:hover {
		border-color: var(--text-secondary);
	}

	.theme-btn.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		font-weight: 500;
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

	.server-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
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
