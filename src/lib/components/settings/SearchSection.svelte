<script lang="ts">
	import {
		getSettings,
		updateSettings,
		updateProxy,
		DEFAULT_SEARXNG_URL,
		type AppSettings,
		type SearchProvider,
		type ProxyMode
	} from '$lib/stores/settings';
	import ModeSelector from '$lib/components/ModeSelector.svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { listen } from '@tauri-apps/api/event';
	import type { DetectedBrowser } from '$lib/ipc/gen/DetectedBrowser';
	import type { BrowserDetectionFailure } from '$lib/ipc/gen/BrowserDetectionFailure';
	import type { BrowserFallbackState } from '$lib/ipc/gen/BrowserFallbackState';

	let searchProvider = $state<SearchProvider>(getSettings().searchProvider);
	let searchRecency = $state(getSettings().searchRecency);
	let braveApiKey = $state(getSettings().braveApiKey);
	let searxngUrl = $state(getSettings().searxngUrl);

	let browserPath = $state(getSettings().browserPath);
	// Detection result for the browser-assisted provider. null = not probed yet.
	let browser = $state<DetectedBrowser | null>(null);
	let browserFailure = $state<BrowserDetectionFailure | null>(null);
	let probing = $state(false);
	// Set while browser mode is degraded and the plain rotation is standing in.
	// Rust owns this state; the card mirrors it and clears when Rust says so.
	let fallback = $state<BrowserFallbackState | null>(null);

	async function probeBrowser() {
		probing = true;
		try {
			browser = await invoke<DetectedBrowser>('detect_browser', {
				overridePath: browserPath || null
			});
			browserFailure = null;
		} catch (e) {
			browser = null;
			browserFailure = e as BrowserDetectionFailure;
		} finally {
			probing = false;
		}
	}

	onMount(() => {
		// Probe only when the mode is actually selected: launching --version on
		// every Settings visit is process churn for a label most users never
		// read.
		if (searchProvider === 'browser') void probeBrowser();
		const unlisten = [
			listen<BrowserFallbackState>('browser-search-fallback', (e) => (fallback = e.payload)),
			listen('browser-search-fallback-cleared', () => (fallback = null))
		];
		return () => void Promise.all(unlisten).then((fns) => fns.forEach((f) => f()));
	});

	function saveBrowserPath() {
		updateSettings({ browserPath });
		void probeBrowser();
	}

	let proxyMode = $state<ProxyMode>(getSettings().proxy.mode);
	let proxyUrl = $state(getSettings().proxy.url);
	let proxyBypass = $state(getSettings().proxy.bypass);

	function setSearchProvider(provider: SearchProvider) {
		searchProvider = provider;
		updateSettings({ searchProvider: provider });
		if (provider === 'browser' && !browser && !browserFailure) void probeBrowser();
	}

	function saveBraveKey() {
		updateSettings({ braveApiKey });
	}

	function saveSearxngUrl() {
		updateSettings({ searxngUrl });
	}

	function setSearchRecency(value: string) {
		searchRecency = value as AppSettings['searchRecency'];
		updateSettings({ searchRecency });
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
</script>

<section class="settings-section">
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
			<option value="browser">Browser-assisted (requires Chrome or Chromium)</option>
		</select>
	</div>

	{#if searchProvider === 'auto' && !braveApiKey}
		<div class="provider-nudge">
			Free public search engines are unreliable — they get rate-limited and their HTML changes break
			scrapers. For stable results, configure
			<strong>Brave Search</strong> (free key, 2,000 queries/month at
			<a href="https://brave.com/search/api/" target="_blank" rel="noopener">brave.com/search/api</a
			>) or a self-hosted <strong>SearXNG</strong> instance. Deep research with Auto will use slower pacing
			to compensate.
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

	{#if searchProvider === 'browser'}
		<div class="browser-block">
			{#if fallback}
				<!-- Deliberately not dismissible: dismissing would restore exactly
				     the silence this exists to prevent. It clears when Rust says
				     browser mode worked again. -->
				<div class="warn-card">
					<strong>Browser search is not working.</strong>
					Searches are using the standard rotation instead.
					<div class="warn-reason">{fallback.reason}</div>
					{#if fallback.searched.length}
						<div class="warn-paths">Looked in: {fallback.searched.join(', ')}</div>
					{/if}
				</div>
			{/if}

			{#if probing}
				<p class="hint">Looking for a browser…</p>
			{:else if browser}
				<p class="hint">
					Using <strong>{browser.version}</strong> — <code>{browser.path}</code>
					{#if browser.from_override}(set manually below){/if}
				</p>
			{:else if browserFailure}
				<div class="warn-card">
					<strong>No Chrome or Chromium found.</strong>
					{#if browserFailure.override_error}
						<div class="warn-reason">{browserFailure.override_error}</div>
					{/if}
					{#if browserFailure.searched.length}
						<div class="warn-paths">Looked in: {browserFailure.searched.join(', ')}</div>
					{/if}
					<div class="warn-reason">
						Any Chromium-based browser works — Chrome, Chromium, Brave or Edge. On Windows, Edge is
						installed by default, so this usually means it lives somewhere unusual; set the path
						below.
					</div>
				</div>
			{/if}

			<button class="btn btn-small" onclick={probeBrowser} disabled={probing}>
				{probing ? 'Checking…' : 'Check again'}
			</button>

			<div class="search-field" style="margin-top: 10px">
				<label for="browser-path">Browser path (optional):</label>
				<input
					id="browser-path"
					type="text"
					bind:value={browserPath}
					onblur={saveBrowserPath}
					placeholder="Detected automatically — set only if detection misses"
				/>
			</div>

			<p class="hint">
				Every search runs in a real browser, which is what gets past the JavaScript checks some
				engines now use — it unlocks Startpage, which the standard rotation can't reach. The browser
				starts when you search and shuts down when idle, and searches take roughly twice as long. If
				no browser is available, searches fall back to the standard rotation and say so.
			</p>
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
				placeholder={DEFAULT_SEARXNG_URL}
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

<section class="settings-section">
	<h2>Network Proxy</h2>
	<p class="hint">
		Route outbound web traffic (search, URL fetch, image search) through an HTTP/HTTPS proxy. Leave
		set to <strong>None</strong> to connect directly.
	</p>
	<div class="proxy-modes">
		<ModeSelector
			name="proxy-mode"
			direction="row"
			value={proxyMode}
			onchange={setProxyMode}
			options={[
				{ value: 'none', title: 'None', description: 'Direct connection' },
				{ value: 'manual', title: 'Manual', description: 'Route all traffic through a proxy URL' }
			]}
		/>
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
				One entry per line (or comma-separated). Each entry can be a hostname (matches the host and
				any subdomain), an individual IP address, or a CIDR subnet (e.g.
				<code>10.0.0.0/8</code>, <code>2001:db8::/32</code>).
			</p>
		</div>
	{/if}
</section>

<style>
	.browser-block {
		margin-top: 10px;
	}

	.warn-card {
		border: 1px solid var(--warning, #b4791f);
		border-radius: 6px;
		padding: 10px 12px;
		margin-bottom: 10px;
		background: var(--bg-secondary);
		font-size: 0.85rem;
	}

	.warn-reason,
	.warn-paths {
		margin-top: 6px;
		color: var(--text-secondary);
		font-size: 0.8rem;
		word-break: break-word;
	}

	.hint {
		margin: 0 0 16px 0;
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

	.search-provider select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.search-field {
		margin-bottom: 12px;
	}

	/* Not a flex wrapper: that would shrink-wrap the segmented control to
	   its content width instead of letting it fill the pane. */
	.proxy-modes {
		margin-bottom: 12px;
	}
</style>
