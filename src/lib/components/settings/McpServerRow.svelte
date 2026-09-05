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
		mcpServerLogs,
		mcpState,
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
	// Phase 07 adds a second status line here for companion-app state
	// ("running, but Blender is not connected").
	const detail = $derived(statusLabel(runtime));

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

<div class="server-row" class:failed>
	<div class="header">
		<label class="toggle-row">
			<input
				type="checkbox"
				checked={config.enabled}
				onchange={() => onchange({ ...config, enabled: !config.enabled })}
			/>
			<span class="label">{config.label}</span>
		</label>
		<span class="status" class:running class:failed>{detail}</span>
		{#if runtime.connection}
			<span class="era">{runtime.connection.era === 'modern' ? 'stateless' : 'handshake'}</span>
		{/if}
		{#if runtime.tools.length}
			<span class="tool-count">{runtime.tools.length} tools</span>
		{/if}
	</div>

	{#if !config.setupComplete}
		<p class="needs-setup">
			Setup is not finished, so this server will not start.
			<button type="button" class="link-button" onclick={() => (showSetup = true)}>
				Continue setup
			</button>
		</p>
	{/if}

	{#if runtime.error}
		<p class="error">{runtime.error}</p>
		<button type="button" class="link-button" onclick={toggleLogs}>
			{showLogs ? 'Hide' : 'Show'} the server's own output
		</button>
		{#if showLogs}
			<pre class="logs">{logs.join('\n') || 'The server printed nothing.'}</pre>
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

	{#if showTools}
		<McpToolList
			tools={runtime.tools}
			toolEnabled={config.toolEnabled as Record<string, boolean>}
			defaultTools={entry?.defaultTools ?? []}
			onchange={(toolEnabled) => onchange({ ...config, toolEnabled })}
		/>
	{/if}
</div>

<style>
	.server-row {
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--border-subtle, #292524);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.label {
		font-weight: 600;
	}
	.status,
	.era,
	.tool-count {
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
	.status.running {
		color: var(--accent, #14b8a6);
	}
	.status.failed {
		color: var(--danger, #ef4444);
	}
	.needs-setup,
	.error {
		font-size: 0.9em;
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
