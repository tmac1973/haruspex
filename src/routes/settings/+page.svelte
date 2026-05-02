<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		startServer,
		stopServer,
		getServerState,
		enterRemoteMode,
		exitRemoteMode
	} from '$lib/stores/server.svelte';
	import {
		getSettings,
		updateSettings,
		updateInferenceBackend,
		updateProxy,
		setEmailAccounts,
		applyTheme,
		getActiveContextSize,
		type ResponseFormat,
		type ThemeMode,
		type SearchProvider,
		type AppSettings,
		type InferenceBackendConfig,
		type InferenceMode,
		type EmailAccount,
		type EmailProviderId,
		type EmailTlsMode,
		type ProxyMode
	} from '$lib/stores/settings';
	import { setContextSize as setIndicatorContextSize } from '$lib/stores/context.svelte';
	import InferenceBackendForm from '$lib/components/InferenceBackendForm.svelte';
	import EmailAccountForm from '$lib/components/EmailAccountForm.svelte';
	import { clearDebugLogs } from '$lib/debug-log';

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
	let defaultWorkingDir = $state(getSettings().defaultWorkingDir);

	let proxyMode = $state<ProxyMode>(getSettings().proxy.mode);
	let proxyUrl = $state(getSettings().proxy.url);
	let proxyBypass = $state(getSettings().proxy.bypass);

	// Local mirror of the inference backend config. We pass the live
	// value into InferenceBackendForm and commit updates via its
	// onConfigChange callback. The `mode` field drives a bunch of
	// conditionals below (hiding local-only sections, showing the
	// remote form, switching the sidecar on/off).
	let inferenceBackend = $state<InferenceBackendConfig>(getSettings().inferenceBackend);

	const remoteMode = $derived(inferenceBackend.mode === 'remote');

	async function setInferenceMode(mode: InferenceMode) {
		if (mode === inferenceBackend.mode) return;
		inferenceBackend = { ...inferenceBackend, mode };
		updateInferenceBackend({ mode });
		// Refresh the header context indicator immediately so it reflects
		// the new backend's ceiling instead of the previous one's stale value.
		setIndicatorContextSize(getActiveContextSize());
		if (mode === 'remote') {
			// Stop the local llama-server sidecar — no point burning
			// VRAM on a model we're not going to query. Then flip the
			// server-store status to the synthetic 'remote' state so
			// the badge in the header updates.
			try {
				await stopServer();
			} catch (e) {
				console.warn('stopServer on remote toggle failed:', e);
			}
			const label = shortRemoteLabel(inferenceBackend.remoteBaseUrl);
			enterRemoteMode(label);
		} else {
			// Flipping back to local: leave the synthetic 'remote' state
			// and spin the local sidecar up with the currently-selected
			// model + configured context size. If no model is downloaded
			// yet, the layout's first-run redirect will kick in instead.
			exitRemoteMode();
			try {
				const modelPath = await invoke<string | null>('get_active_model_path');
				if (modelPath) {
					await startServer(modelPath, getSettings().contextSize);
				}
			} catch (e) {
				console.warn('startServer on local toggle failed:', e);
			}
		}
	}

	function onInferenceConfigChange(next: InferenceBackendConfig) {
		inferenceBackend = next;
		updateInferenceBackend(next);
		// If we're already in remote mode, keep the header label in sync
		// with the (possibly just-changed) base URL.
		if (next.mode === 'remote') {
			enterRemoteMode(shortRemoteLabel(next.remoteBaseUrl));
		}
	}

	function shortRemoteLabel(baseUrl: string): string {
		try {
			const u = new URL(baseUrl);
			return u.port ? `${u.hostname}:${u.port}` : u.hostname;
		} catch {
			return baseUrl;
		}
	}

	// --- Email integration state ---
	interface EmailProviderPreset {
		id: string;
		label: string;
		imap_host: string;
		imap_port: number;
		imap_tls: EmailTlsMode;
		smtp_host: string;
		smtp_port: number;
		smtp_tls: EmailTlsMode;
		app_password_url: string;
		requires_2fa: boolean;
	}

	let emailAccounts = $state<EmailAccount[]>(
		structuredClone(getSettings().integrations.email.accounts)
	);
	let emailPresets = $state<EmailProviderPreset[]>([]);

	async function loadEmailPresets() {
		try {
			emailPresets = await invoke<EmailProviderPreset[]>('email_list_providers');
		} catch (e) {
			console.error('email_list_providers failed:', e);
		}
	}

	function newBlankAccount(): EmailAccount {
		// Generate a stable id using the browser's crypto.randomUUID()
		// when available, falling back to a timestamp-plus-random pair
		// for older environments that tauri-webview might present.
		const id =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const preset = emailPresets.find((p) => p.id === 'gmail');
		return {
			id,
			label: 'New account',
			enabled: false,
			sendEnabled: false,
			provider: 'gmail' as EmailProviderId,
			emailAddress: '',
			password: '',
			imapHost: preset?.imap_host ?? 'imap.gmail.com',
			imapPort: preset?.imap_port ?? 993,
			imapTls: preset?.imap_tls ?? 'implicit',
			smtpHost: preset?.smtp_host ?? 'smtp.gmail.com',
			smtpPort: preset?.smtp_port ?? 465,
			smtpTls: preset?.smtp_tls ?? 'implicit'
		};
	}

	function addEmailAccount() {
		emailAccounts = [...emailAccounts, newBlankAccount()];
		setEmailAccounts(emailAccounts);
	}

	function updateEmailAccount(id: string, next: EmailAccount) {
		emailAccounts = emailAccounts.map((a) => (a.id === id ? next : a));
		setEmailAccounts(emailAccounts);
	}

	function deleteEmailAccount(id: string) {
		emailAccounts = emailAccounts.filter((a) => a.id !== id);
		setEmailAccounts(emailAccounts);
	}

	async function pickDefaultWorkingDir() {
		try {
			const selected = await openDialog({
				directory: true,
				multiple: false,
				title: 'Select default working directory'
			});
			if (typeof selected === 'string') {
				defaultWorkingDir = selected;
				updateSettings({ defaultWorkingDir: selected });
			}
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	function clearDefaultWorkingDir() {
		defaultWorkingDir = '';
		updateSettings({ defaultWorkingDir: '' });
	}

	function setTtsVoice(voice: string) {
		ttsVoice = voice;
		updateSettings({ ttsVoice: voice });
	}

	let ttsReadTablesByColumn = $state(getSettings().ttsReadTablesByColumn);

	function toggleTableReading() {
		ttsReadTablesByColumn = !ttsReadTablesByColumn;
		updateSettings({ ttsReadTablesByColumn });
	}

	let debugClearLabel = $state('Clear debug log');

	function clearDebugLog() {
		clearDebugLogs();
		debugClearLabel = 'Cleared';
		setTimeout(() => {
			debugClearLabel = 'Clear debug log';
		}, 1500);
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

	function setProxyMode(mode: ProxyMode) {
		proxyMode = mode;
		updateProxy({ mode });
	}

	function saveProxyUrl() {
		updateProxy({ url: proxyUrl.trim() });
	}

	function saveProxyBypass() {
		updateProxy({ bypass: proxyBypass });
	}

	const proxyBypassPlaceholder = 'example.com\n192.168.1.5\n10.0.0.0/8';

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
		await loadEmailPresets();
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
		await startServer(path, getSettings().contextSize);
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
		<h2>Inference backend</h2>
		<p class="hint">
			Haruspex normally manages its own llama-server sidecar with a downloaded model. If you already
			run an inference server (LM Studio, Lemonade, Ollama, llama.cpp, llama-toolchest, vLLM, TGI,
			etc.) you can point Haruspex at it instead — the local sidecar will shut down and chat
			requests will route to your server.
		</p>
		<div class="backend-mode-row">
			<label class="backend-mode-option" class:selected={!remoteMode}>
				<input
					type="radio"
					name="inference-mode"
					value="local"
					checked={!remoteMode}
					onchange={() => setInferenceMode('local')}
				/>
				<div>
					<strong>Local (Haruspex-managed)</strong>
					<span>llama-server sidecar with a model managed by Haruspex. Recommended.</span>
				</div>
			</label>
			<label class="backend-mode-option" class:selected={remoteMode}>
				<input
					type="radio"
					name="inference-mode"
					value="remote"
					checked={remoteMode}
					onchange={() => setInferenceMode('remote')}
				/>
				<div>
					<strong>Remote server (advanced)</strong>
					<span>Point at an existing OpenAI-compatible inference server.</span>
				</div>
			</label>
		</div>
		{#if remoteMode}
			<div class="remote-form-wrapper">
				<InferenceBackendForm config={inferenceBackend} onConfigChange={onInferenceConfigChange} />
			</div>
		{/if}
	</section>

	{#if !remoteMode}
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
	{/if}

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

		{#if searchProvider === 'auto' && !braveApiKey}
			<div class="provider-nudge">
				Free public search engines are unreliable — they get rate-limited and their HTML changes
				break scrapers. For stable results, configure
				<strong>Brave Search</strong> (free key, 2,000 queries/month at
				<a href="https://brave.com/search/api/" target="_blank" rel="noopener"
					>brave.com/search/api</a
				>) or a self-hosted <strong>SearXNG</strong> instance. Deep research with Auto will use slower
				pacing to compensate.
			</div>
		{/if}

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
		<h2>Network Proxy</h2>
		<p class="hint">
			Route outbound web traffic (search, URL fetch, image search) through an HTTP/HTTPS proxy.
			Leave set to <strong>None</strong> to connect directly.
		</p>
		<div class="proxy-modes">
			<label class="proxy-mode" class:selected={proxyMode === 'none'}>
				<input
					type="radio"
					name="proxy-mode"
					value="none"
					checked={proxyMode === 'none'}
					onchange={() => setProxyMode('none')}
				/>
				<div>
					<strong>None</strong>
					<span>Direct connection</span>
				</div>
			</label>
			<label class="proxy-mode" class:selected={proxyMode === 'manual'}>
				<input
					type="radio"
					name="proxy-mode"
					value="manual"
					checked={proxyMode === 'manual'}
					onchange={() => setProxyMode('manual')}
				/>
				<div>
					<strong>Manual</strong>
					<span>Route all traffic through a proxy URL</span>
				</div>
			</label>
		</div>

		{#if proxyMode === 'manual'}
			<div class="search-field">
				<label for="proxy-url">Proxy URL:</label>
				<input
					id="proxy-url"
					type="text"
					bind:value={proxyUrl}
					onblur={saveProxyUrl}
					placeholder="http://host:port or http://user:pass@host:port"
				/>
				<p class="hint">
					Used for both HTTP and HTTPS destinations. Include <code>user:pass@</code> in the URL for proxies
					that require authentication.
				</p>
			</div>

			<div class="search-field">
				<label for="proxy-bypass">No proxy for:</label>
				<textarea
					id="proxy-bypass"
					rows="4"
					bind:value={proxyBypass}
					onblur={saveProxyBypass}
					placeholder={proxyBypassPlaceholder}
				></textarea>
				<p class="hint">
					One entry per line (or comma-separated). Each entry can be a hostname (matches the host
					and any subdomain), an individual IP address, or a CIDR subnet (e.g. <code
						>10.0.0.0/8</code
					>, <code>2001:db8::/32</code>).
				</p>
			</div>
		{/if}
	</section>

	{#if !remoteMode}
		<section>
			<h2>Context Size</h2>
			<p class="hint">
				Larger context allows longer conversations but uses more VRAM. Requires server restart to
				take effect.
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
	{/if}

	<section>
		<h2>Default Working Directory</h2>
		<p class="hint">
			When set, new chats automatically start with this working directory, enabling filesystem tools
			without having to pick a folder each time. You can still change or clear it per chat with the
			folder button in the input row.
		</p>
		<div class="workingdir-row">
			{#if defaultWorkingDir}
				<code class="workingdir-path" title={defaultWorkingDir}>{defaultWorkingDir}</code>
				<button class="btn" onclick={pickDefaultWorkingDir}>Change</button>
				<button class="btn btn-danger" onclick={clearDefaultWorkingDir}>Clear</button>
			{:else}
				<span class="workingdir-empty">No default set</span>
				<button class="btn btn-primary" onclick={pickDefaultWorkingDir}>Choose Folder</button>
			{/if}
		</div>
	</section>

	<section>
		<h2>Integrations</h2>
		<p class="section-help">
			Optional connections to outside services. Disabled by default. Email tools become available to
			the model as soon as at least one account is enabled.
		</p>

		<h3 class="subhead">Email (read-only)</h3>
		<p class="section-help small">
			Multi-provider IMAP access for reading recent email and summarizing it. Supports Gmail,
			Fastmail, iCloud, Yahoo, and any IMAP host you can reach. Every preset requires 2FA to be
			enabled on the provider and an app password (not your login password). Sending email arrives
			in a later phase.
		</p>

		{#if emailAccounts.length === 0}
			<p class="section-help small">No email accounts configured.</p>
		{/if}

		{#each emailAccounts as account (account.id)}
			<EmailAccountForm
				{account}
				presets={emailPresets}
				onChange={(next) => updateEmailAccount(account.id, next)}
				onDelete={() => deleteEmailAccount(account.id)}
			/>
		{/each}

		<button class="btn" onclick={addEmailAccount}>Add email account</button>
	</section>

	<section>
		<h2>Debug</h2>
		<p class="section-help">
			Every chat turn streams full request payloads, model responses, tool calls, and recovery
			branches into an in-memory ring buffer (5000 entries). Open the Log Viewer's "Debug" tab to
			see the full buffer; when a turn fails, use the "Copy debug log" button on the error message
			to grab just that turn's entries. The buffer lives only in memory and resets on every app
			restart.
		</p>
		<button class="btn" onclick={clearDebugLog}>{debugClearLabel}</button>
	</section>

	{#if !remoteMode}
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
	{/if}
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

	.subhead {
		margin: 16px 0 4px;
		font-size: 1rem;
	}

	.section-help {
		color: var(--text-secondary, var(--text-muted));
		font-size: 0.9rem;
		margin: 0 0 12px;
	}

	.section-help.small {
		font-size: 0.85rem;
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

	.provider-nudge {
		margin: 12px 0;
		padding: 10px 12px;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-primary);
		background: var(--bg-secondary);
		border-left: 3px solid var(--accent);
		border-radius: 4px;
	}

	.provider-nudge a {
		color: var(--accent);
		text-decoration: underline;
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
	.search-field input,
	.search-field textarea {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.search-field textarea {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		resize: vertical;
		min-height: 80px;
	}

	.proxy-modes {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}

	.proxy-mode {
		flex: 1;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.proxy-mode:hover {
		border-color: var(--text-secondary);
	}

	.proxy-mode.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.proxy-mode input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.proxy-mode strong {
		display: block;
		font-size: 0.9rem;
	}

	.proxy-mode span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
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

	.backend-mode-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 12px;
	}

	.backend-mode-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.backend-mode-option:hover {
		border-color: var(--text-secondary);
	}

	.backend-mode-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.backend-mode-option input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.backend-mode-option strong {
		display: block;
		font-size: 0.9rem;
	}

	.backend-mode-option span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.remote-form-wrapper {
		margin-top: 4px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.workingdir-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.workingdir-path {
		flex: 1;
		min-width: 0;
		padding: 8px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.workingdir-empty {
		flex: 1;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-style: italic;
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
