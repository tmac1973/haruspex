<script lang="ts">
	/**
	 * One configured MCP server: its status, what protocol it settled on, and
	 * the controls to run, configure or remove it.
	 *
	 * A non-technical user's entire diagnostic surface for a third-party server
	 * is this row, so a failure says what went wrong in words first, with the
	 * raw log available behind a disclosure rather than shouted.
	 */
	import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
	import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
	import {
		companionWarning,
		mcpServerLogs,
		mcpState,
		probeCompanion,
		removeMcpServer,
		startMcpServer,
		statusLabel
	} from '$lib/stores/mcpServers.svelte';
	import McpToolList from './McpToolList.svelte';
	import McpSetupWizard from './McpSetupWizard.svelte';

	interface Props {
		config: McpServerConfig;
		entry: CatalogEntry | null;
		onchange: (next: McpServerConfig) => void;
		onremove: () => void;
	}

	const { config, entry, onchange, onremove }: Props = $props();

	let showTools = $state(false);
	let showSetup = $state(false);
	let logs = $state<string[]>([]);
	let showLogs = $state(false);

	const runtime = $derived(mcpState(config.id));
	const running = $derived(runtime.status.type === 'Ready');
	const failed = $derived(runtime.status.type === 'Error');
	const detail = $derived(statusLabel(runtime));
	// The second status line. A process that is fine while the application it
	// bridges to is absent is exactly the case a single green dot gets wrong.
	const companionHint = $derived(companionWarning(runtime));
	let reprobing = $state(false);

	/**
	 * What each proxy choice does, named against the settings the user can go
	 * and look at.
	 *
	 * A remote server's connection is ours to make, so the wording is about what
	 * Haruspex does. A stdio server's connections are its own; all we do is set
	 * environment variables and hope it reads them, so the wording names the
	 * variables and says "should" rather than "will".
	 *
	 * `title` on an <option> is not shown by every browser, so the same text
	 * also sits on the summary beside the control.
	 */
	const proxyHelp = $derived(
		config.source.kind === 'remote'
			? {
					auto: 'Haruspex connects through the proxy in Settings → Network, except for hosts on the Proxy Bypass List and localhost.',
					always:
						'Haruspex connects through the proxy in Settings → Network even for hosts on the Proxy Bypass List. localhost is still reached directly.',
					never: 'Haruspex connects directly, even when a proxy is set in Settings → Network.'
				}
			: {
					auto: 'Sets HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and NO_PROXY (upper and lower case) from Settings → Network; NO_PROXY holds the Proxy Bypass List plus localhost. Connections this server makes should go through the proxy, if it reads these variables.',
					always:
						'Sets the same variables, but NO_PROXY holds only localhost — the Proxy Bypass List is ignored. Connections this server makes should go through the proxy even for hosts on that list.',
					never:
						'Sets no proxy environment variables for this server. Connections this server makes should be direct.'
				}
	);

	const proxySummary = $derived(
		config.source.kind === 'remote' ? 'For this connection' : 'Passed to the server; best effort'
	);

	async function recheckCompanion(): Promise<void> {
		reprobing = true;
		try {
			await probeCompanion(config);
		} finally {
			reprobing = false;
		}
	}

	async function toggleLogs(): Promise<void> {
		showLogs = !showLogs;
		if (showLogs) logs = await mcpServerLogs(config.id);
	}

	async function start(): Promise<void> {
		await startMcpServer(config, entry);
	}

	async function remove(): Promise<void> {
		await removeMcpServer(config.id);
		onremove();
	}
</script>

<section class="settings-section" class:failed>
	<h2>{config.label}</h2>
	<div class="header">
		<label class="toggle-row">
			<input
				type="checkbox"
				checked={config.enabled}
				onchange={() => onchange({ ...config, enabled: !config.enabled })}
			/>
			<span>Enabled</span>
		</label>
		<span class="status" class:running class:failed>{detail}</span>
		{#if config.source.kind === 'remote'}
			<span class="remote" title={config.source.url}>remote</span>
		{/if}
		{#if runtime.connection}
			<span class="era">{runtime.connection.era === 'modern' ? 'stateless' : 'handshake'}</span>
		{/if}
		{#if runtime.tools.length}
			<span class="tool-count">{runtime.tools.length} tools</span>
		{/if}
	</div>

	{#if companionHint}
		<p class="companion">
			<span class="companion-state">{entry?.companion?.app ?? 'The application'} not connected</span
			>
			{companionHint}
			<button type="button" class="link-button" disabled={reprobing} onclick={recheckCompanion}>
				{reprobing ? 'Checking…' : 'Check again'}
			</button>
		</p>
	{/if}

	{#if !config.setupComplete}
		<p class="needs-setup">
			Setup unfinished.
			<button type="button" class="link-button" onclick={() => (showSetup = true)}>Continue</button>
		</p>
	{/if}

	{#if runtime.error}
		<p class="error">{runtime.error}</p>
		<button type="button" class="link-button" onclick={toggleLogs}>
			{showLogs ? 'Hide output' : 'Show output'}
		</button>
		{#if showLogs}
			<pre class="logs">{logs.join('\n') || 'No output.'}</pre>
		{/if}
	{/if}

	<div class="actions">
		<button
			type="button"
			disabled={runtime.busy || running || !config.setupComplete}
			onclick={start}
		>
			Start
		</button>
		{#if entry?.setup.length}
			<button type="button" onclick={() => (showSetup = !showSetup)}>
				{showSetup ? 'Close setup' : 'Setup'}
			</button>
		{/if}
		<button type="button" onclick={() => (showTools = !showTools)}>
			{showTools ? 'Hide tools' : 'Tools'}
		</button>
		<button type="button" class="danger" onclick={remove}>Remove</button>
	</div>

	{#if showSetup && entry}
		<McpSetupWizard
			{config}
			steps={entry.setup}
			{onchange}
			ondone={() => (showSetup = false)}
			oncancel={() => (showSetup = false)}
		/>
	{/if}

	<label class="proxy-choice">
		Proxy
		<select
			value={config.proxyUse}
			onchange={(e) =>
				onchange({ ...config, proxyUse: e.currentTarget.value as McpServerConfig['proxyUse'] })}
		>
			<option value="auto" title={proxyHelp.auto}>Use the app setting</option>
			<option value="always" title={proxyHelp.always}>Always</option>
			<option value="never" title={proxyHelp.never}>Never</option>
		</select>
		<span class="hint" title={proxyHelp[config.proxyUse]}>{proxySummary}</span>
	</label>

	{#if showTools}
		<McpToolList
			tools={runtime.tools}
			toolEnabled={config.toolEnabled as Record<string, boolean>}
			defaultTools={entry?.defaultTools ?? []}
			onchange={(toolEnabled) => onchange({ ...config, toolEnabled })}
		/>
	{/if}
</section>

<style>
	.failed {
		border-color: var(--danger, #ef4444);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.status,
	.era,
	.remote,
	.tool-count {
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
	.remote {
		border: 1px solid var(--border-subtle, #292524);
		border-radius: 3px;
		padding: 0 0.35rem;
	}
	.status.running {
		color: var(--accent, #14b8a6);
	}
	.status.failed {
		color: var(--danger, #ef4444);
	}
	.needs-setup,
	.companion,
	.error {
		font-size: 0.9em;
	}
	.companion {
		border-left: 3px solid var(--warning, #d97706);
		padding-left: 0.75rem;
	}
	.companion-state {
		font-weight: 600;
		display: block;
	}
	.error {
		color: var(--danger, #ef4444);
	}
	.logs {
		max-height: 12rem;
		overflow: auto;
		font-size: 0.8em;
		white-space: pre-wrap;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.proxy-choice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
		font-size: 0.9em;
	}
	.proxy-choice .hint {
		color: var(--text-secondary, #a8a29e);
		font-size: 0.85em;
	}
	.link-button {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #14b8a6);
		cursor: pointer;
	}
	.danger {
		color: var(--danger, #ef4444);
	}
</style>
