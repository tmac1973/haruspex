<script lang="ts">
	/**
	 * App-wide egress: the HTTP proxy every outbound connection goes through.
	 *
	 * Lived inside the Search section until now, which understated it. The
	 * setting was already app-wide in the data model — the Python sandbox's
	 * fetches use it too — and MCP made that plain: a user who routes their
	 * traffic through a proxy did not mean "except for the integrations".
	 *
	 * Loopback is never proxied, whatever is configured here, so a server the
	 * user runs on their own machine works without them having to know that.
	 */
	import { getSettings, updateProxy, type ProxyMode } from '$lib/stores/settings';
	import ModeSelector from '$lib/components/ModeSelector.svelte';

	let proxyMode = $state<ProxyMode>(getSettings().proxy.mode);
	let proxyUrl = $state(getSettings().proxy.url);
	let proxyBypass = $state(getSettings().proxy.bypass);

	function setProxyMode(mode: ProxyMode): void {
		proxyMode = mode;
		updateProxy({ mode });
	}

	function saveProxyUrl(): void {
		updateProxy({ url: proxyUrl.trim() });
	}

	function saveProxyBypass(): void {
		updateProxy({ bypass: proxyBypass });
	}

	const proxyBypassPlaceholder = 'example.com\n192.168.1.5\n10.0.0.0/8';
</script>

<section class="settings-section">
	<h2>Network Proxy</h2>
	<p class="hint" title="Covers web search, page fetches, downloads, and MCP servers.">
		Route everything Haruspex sends out through an HTTP/HTTPS proxy.
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
		<div class="field">
			<label for="proxy-url">Proxy URL:</label>
			<input
				id="proxy-url"
				type="text"
				bind:value={proxyUrl}
				onblur={saveProxyUrl}
				placeholder="http://host:port or http://user:pass@host:port"
			/>
			<p class="hint">
				Used for HTTP and HTTPS. Include <code>user:pass@</code> if the proxy needs credentials.
			</p>
		</div>

		<div class="field">
			<label for="proxy-bypass">No proxy for:</label>
			<textarea
				id="proxy-bypass"
				rows="4"
				bind:value={proxyBypass}
				onblur={saveProxyBypass}
				placeholder={proxyBypassPlaceholder}
			></textarea>
			<p class="hint" title="Hostnames match the host and any subdomain.">
				One per line: hostname, IP, or CIDR subnet. <code>localhost</code> is always direct.
			</p>
		</div>
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
