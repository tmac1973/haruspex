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
	<p class="hint">
		Route everything Haruspex sends out — web search, page fetches, model and integration downloads,
		and MCP servers reached over the network — through an HTTP/HTTPS proxy. Leave set to <strong
			>None</strong
		> to connect directly.
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
				Used for both HTTP and HTTPS destinations. Include <code>user:pass@</code> in the URL for proxies
				that require authentication.
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
			<p class="hint">
				One entry per line (or comma-separated). Each entry can be a hostname (matches the host and
				any subdomain), an individual IP address, or a CIDR subnet (e.g.
				<code>10.0.0.0/8</code>, <code>2001:db8::/32</code>).
			</p>
			<p class="hint">
				<code>localhost</code> and <code>127.0.0.1</code> are always reached directly and do not need
				listing. Private ranges are not assumed — add them here if your network does not proxy them.
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
