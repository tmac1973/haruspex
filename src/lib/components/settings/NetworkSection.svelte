<script lang="ts">
	/**
	 * Two proxies. The network proxy covers everything Haruspex sends out
	 * except web search: downloads, MCP servers, CalDAV, ComfyUI installs and
	 * the Python sandbox. Web search (search engines, the pages they return,
	 * image search) has its own, because the two do different jobs — a search
	 * proxy keeps engines from rate limiting or profiling one address, a
	 * network proxy is how traffic leaves a network at all — and routing a
	 * multi-GB model download through a search VPN helps nobody. Search can
	 * follow the network proxy with one choice.
	 *
	 * Loopback is never proxied, whatever is configured here, so a server the
	 * user runs on their own machine works without them having to know that.
	 */
	import {
		getSettings,
		updateProxy,
		updateSearchProxy,
		type ProxyMode,
		type SearchProxyConfig
	} from '#lib/stores/settings.ts';
	import ModeSelector from '#lib/components/ModeSelector.svelte';
	import { saveProxyUrl, type WhichProxy } from '#lib/stores/proxySecrets.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let proxyMode = $state<ProxyMode>(getSettings().proxy.mode);
	let proxyUrl = $state(getSettings().proxy.url);
	let proxyBypass = $state(getSettings().proxy.bypass);

	let searchMode = $state<SearchProxyConfig['mode']>(getSettings().searchProxy.mode);
	let searchUrl = $state(getSettings().searchProxy.url);
	let searchBypass = $state(getSettings().searchProxy.bypass);

	/** Why a proxy URL wasn't saved: the secret store can refuse its password. */
	let urlError = $state<Record<WhichProxy, string>>({ network: '', search: '' });

	async function saveUrl(which: WhichProxy, raw: string): Promise<void> {
		urlError[which] = '';
		try {
			await saveProxyUrl(which, raw);
		} catch (e) {
			urlError[which] = `Not saved: ${errMessage(e)}`;
			return;
		}
		if (which === 'network') proxyUrl = getSettings().proxy.url;
		else searchUrl = getSettings().searchProxy.url;
	}

	function setProxyMode(mode: ProxyMode): void {
		proxyMode = mode;
		updateProxy({ mode });
	}

	function setSearchMode(mode: SearchProxyConfig['mode']): void {
		searchMode = mode;
		updateSearchProxy({ mode });
	}

	const proxyBypassPlaceholder = 'example.com\n192.168.1.5\n10.0.0.0/8';
</script>

{#snippet proxyFields(
	id: string,
	url: string,
	bypass: string,
	setUrl: (v: string) => void,
	setBypass: (v: string) => void,
	saveUrl: () => void,
	saveBypass: () => void,
	error: string
)}
	<div class="field">
		<label for="{id}-url">Proxy URL:</label>
		<input
			id="{id}-url"
			type="text"
			value={url}
			oninput={(e) => setUrl(e.currentTarget.value)}
			onblur={saveUrl}
			placeholder="http://host:port or http://user:pass@host:port"
		/>
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<p
			class="hint"
			title="The password is kept in the system keychain, or Haruspex's encrypted secrets file, and removed from the URL shown here."
		>
			Used for HTTP and HTTPS. Include <code>user:pass@</code> if the proxy needs credentials.
		</p>
	</div>

	<div class="field">
		<label for="{id}-bypass">Proxy Bypass List:</label>
		<textarea
			id="{id}-bypass"
			rows="4"
			value={bypass}
			oninput={(e) => setBypass(e.currentTarget.value)}
			onblur={saveBypass}
			placeholder={proxyBypassPlaceholder}></textarea>
		<p class="hint" title="Hostnames match the host and any subdomain.">
			Reached directly, never through the proxy. One per line: hostname, IP, or CIDR subnet.
			<code>localhost</code> is always on this list.
		</p>
	</div>
{/snippet}

<section class="settings-section">
	<h2>Network Proxy</h2>
	<p
		class="hint"
		title="Model downloads, MCP servers, CalDAV/CardDAV, ComfyUI installs and the Python sandbox."
	>
		Route everything except web search through an HTTP/HTTPS proxy.
	</p>
	<div class="proxy-modes">
		<ModeSelector
			name="proxy-mode"
			value={proxyMode}
			onchange={setProxyMode}
			options={[
				{ value: 'none', title: 'None', description: 'Direct connection' },
				{ value: 'manual', title: 'Manual', description: 'Through a proxy URL' }
			]}
		/>
	</div>

	{#if proxyMode === 'manual'}
		{@render proxyFields(
			'proxy',
			proxyUrl,
			proxyBypass,
			(v) => (proxyUrl = v),
			(v) => (proxyBypass = v),
			() => void saveUrl('network', proxyUrl),
			() => updateProxy({ bypass: proxyBypass }),
			urlError.network
		)}
	{/if}
</section>

<section class="settings-section">
	<h2>Web Search Proxy</h2>
	<p class="hint" title="Web search, the pages it opens, and image search.">
		Route web search through its own proxy, the network proxy, or neither.
	</p>
	<div class="proxy-modes">
		<ModeSelector
			name="search-proxy-mode"
			value={searchMode}
			onchange={setSearchMode}
			options={[
				{ value: 'none', title: 'None', description: 'Direct connection' },
				{ value: 'network', title: 'Network proxy', description: 'Same as above' },
				{ value: 'manual', title: 'Manual', description: 'Through its own proxy URL' }
			]}
		/>
	</div>

	{#if searchMode === 'manual'}
		{@render proxyFields(
			'search-proxy',
			searchUrl,
			searchBypass,
			(v) => (searchUrl = v),
			(v) => (searchBypass = v),
			() => void saveUrl('search', searchUrl),
			() => updateSearchProxy({ bypass: searchBypass }),
			urlError.search
		)}
	{/if}
</section>

<style>
	.proxy-modes {
		margin: 10px 0;
	}
	.field {
		margin-top: 12px;
	}
	.field label {
		display: block;
		margin-bottom: 4px;
	}
	.field input,
	.field textarea {
		width: 100%;
	}
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.9em;
	}
	.hint {
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
</style>
