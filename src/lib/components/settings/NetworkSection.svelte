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
	} from '$lib/stores/settings';
	import ModeSelector from '$lib/components/ModeSelector.svelte';

	let proxyMode = $state<ProxyMode>(getSettings().proxy.mode);
	let proxyUrl = $state(getSettings().proxy.url);
	let proxyBypass = $state(getSettings().proxy.bypass);

	let searchMode = $state<SearchProxyConfig['mode']>(getSettings().searchProxy.mode);
	let searchUrl = $state(getSettings().searchProxy.url);
	let searchBypass = $state(getSettings().searchProxy.bypass);

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
	saveBypass: () => void
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
		<p class="hint">
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
			placeholder={proxyBypassPlaceholder}
		></textarea>
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
			direction="row"
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
			() => updateProxy({ url: proxyUrl.trim() }),
			() => updateProxy({ bypass: proxyBypass })
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
			direction="row"
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
			() => updateSearchProxy({ url: searchUrl.trim() }),
			() => updateSearchProxy({ bypass: searchBypass })
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
	.hint {
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
</style>
