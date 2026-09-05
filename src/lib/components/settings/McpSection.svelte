<script lang="ts">
	/**
	 * Integrations card: the configured MCP servers, the catalog to add more,
	 * and the tier-3 escape hatch for a server the user supplies themselves.
	 *
	 * Owns the CRUD around `settings.integrations.mcp.servers`, the same way
	 * `EmailSection` owns the email accounts. Live state — running, failed,
	 * which tools — lives in `mcpServers.svelte.ts`, because it is not
	 * configuration and must not be persisted.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onMount, onDestroy } from 'svelte';
	import { IPC } from '$lib/ipc/commands';
	import { getSettings, setMcpServers } from '$lib/stores/settings';
	import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
	import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
	import type { RuntimeAvailability } from '$lib/ipc/gen/RuntimeAvailability';
	import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';
	import McpServerRow from './McpServerRow.svelte';
	import McpCatalogBrowser from './McpCatalogBrowser.svelte';
	import { probeCompanion } from '$lib/stores/mcpServers.svelte';

	const INSTALL_PROGRESS_EVENT = 'mcp-install-progress';

	/**
	 * How often to re-check companion applications while this panel is open.
	 *
	 * The realistic flow is: the user reads "Blender is not connected", alt-tabs
	 * to Blender, starts the add-on, and comes back. Without a poll they would
	 * be looking at a stale warning and have to find the "Check again" button to
	 * learn it is fixed. Slow, and only while the panel is visible — a loopback
	 * connect is cheap but not free, and nothing off-screen needs it.
	 */
	const COMPANION_POLL_MS = 5000;

	let servers = $state<McpServerConfig[]>(structuredClone(getSettings().integrations.mcp.servers));
	let catalog = $state<CatalogEntry[]>([]);
	let runtimes = $state<RuntimeAvailability | null>(null);
	let progress = $state<DownloadProgress | null>(null);
	let installingId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let showCatalog = $state(false);
	let showCustom = $state(false);
	let customProgram = $state('');
	let customArgs = $state('');
	let showRemote = $state(false);
	let remoteUrl = $state('');
	let remoteToken = $state('');
	let unlisten: UnlistenFn | null = null;
	let companionPoll: ReturnType<typeof setInterval> | null = null;

	const installedEntryIds = $derived(
		servers.flatMap((s) => (s.source.kind === 'catalog' ? [s.source.entryId] : []))
	);

	/**
	 * Missing runtimes are a broken install of Haruspex, not of a server, so
	 * they are named at the top of the section rather than left to fail an
	 * install halfway through.
	 */
	const runtimeWarning = $derived.by(() => {
		if (!runtimes) return null;
		const missing = [!runtimes.node && 'Node', !runtimes.npm && 'npm', !runtimes.uv && 'uv'].filter(
			(x): x is string => typeof x === 'string'
		);
		if (missing.length === 0) return null;
		return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from this installation of Haruspex. Servers that need ${missing.length === 1 ? 'it' : 'them'} cannot be installed. Reinstalling the app should restore ${missing.length === 1 ? 'it' : 'them'}.`;
	});

	function persist(next: McpServerConfig[]): void {
		servers = next;
		setMcpServers(next);
	}

	function newId(): string {
		return typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function install(entry: CatalogEntry): Promise<void> {
		error = null;
		const id = newId();
		installingId = entry.id;
		progress = null;
		try {
			await invoke(IPC.mcp_install_server, { entryId: entry.id, serverId: id });
			persist([
				...servers,
				{
					id,
					label: entry.name,
					enabled: true,
					source: { kind: 'catalog', entryId: entry.id },
					secrets: {},
					toolEnabled: {},
					// An entry with no setup steps is ready immediately; one with
					// steps is not startable until the wizard says so.
					setupComplete: entry.setup.length === 0
				}
			]);
			showCatalog = false;
		} catch (e) {
			error = String(e);
		} finally {
			installingId = null;
			progress = null;
		}
	}

	async function cancelInstall(): Promise<void> {
		await invoke(IPC.mcp_cancel_install);
	}

	function addCustom(): void {
		const program = customProgram.trim();
		if (!program) return;
		persist([
			...servers,
			{
				id: newId(),
				label: program.split(/[\\/]/).pop() || 'Custom server',
				enabled: true,
				source: {
					kind: 'custom',
					program,
					args: customArgs.trim() ? customArgs.trim().split(/\s+/) : []
				},
				secrets: {},
				toolEnabled: {},
				// No catalog entry means no setup steps to complete.
				setupComplete: true
			}
		]);
		customProgram = '';
		customArgs = '';
		showCustom = false;
	}

	function addRemote(): void {
		const url = remoteUrl.trim();
		if (!url) return;
		let label = url;
		try {
			label = new URL(url).host;
		} catch {
			// An unparseable URL is rejected by the backend with a message about
			// what was typed; falling back to the raw string keeps the row
			// identifiable until then.
		}
		persist([
			...servers,
			{
				id: newId(),
				label,
				enabled: true,
				source: { kind: 'remote', url },
				// The pasted credential is a secret like any other, under the key
				// the backend reads.
				secrets: remoteToken.trim() ? { remoteToken: remoteToken.trim() } : {},
				toolEnabled: {},
				// Nothing to install and no setup steps, so it is ready at once.
				setupComplete: true
			}
		]);
		remoteUrl = '';
		remoteToken = '';
		showRemote = false;
	}

	function entryFor(config: McpServerConfig): CatalogEntry | null {
		if (config.source.kind !== 'catalog') return null;
		const entryId = config.source.entryId;
		return catalog.find((e) => e.id === entryId) ?? null;
	}

	onMount(async () => {
		try {
			catalog = await invoke<CatalogEntry[]>(IPC.mcp_catalog);
		} catch (e) {
			error = String(e);
		}
		try {
			runtimes = await invoke<RuntimeAvailability>(IPC.mcp_runtimes_available);
		} catch {
			// A failed probe is not worth an error banner: the install itself
			// will still say what went wrong, and every kind stays enabled.
		}
		unlisten = await listen<DownloadProgress>(INSTALL_PROGRESS_EVENT, (e) => {
			progress = e.payload;
		});
		companionPoll = setInterval(() => {
			for (const server of servers) {
				if (server.source.kind === 'catalog') void probeCompanion(server);
			}
		}, COMPANION_POLL_MS);
	});

	onDestroy(() => {
		unlisten?.();
		if (companionPoll !== null) clearInterval(companionPoll);
	});
</script>

<section class="settings-section">
	<h2>Integrations</h2>
	<p class="section-help">
		Connect Haruspex to other services through MCP servers. Everything is installed into the app —
		you never need a terminal — and each server's tools stay off until you turn them on.
	</p>

	{#if runtimeWarning}
		<p class="warning">{runtimeWarning}</p>
	{/if}
	{#if error}
		<p class="error">{error}</p>
	{/if}

	{#if servers.length === 0}
		<p class="section-help">No servers yet.</p>
	{:else}
		{#each servers as config (config.id)}
			<McpServerRow
				{config}
				entry={entryFor(config)}
				onchange={(next) => persist(servers.map((s) => (s.id === next.id ? next : s)))}
				onremove={() => persist(servers.filter((s) => s.id !== config.id))}
			/>
		{/each}
	{/if}

	<div class="actions">
		<button type="button" onclick={() => (showCatalog = !showCatalog)}>
			{showCatalog ? 'Close' : 'Add an integration'}
		</button>
		<button type="button" class="advanced" onclick={() => (showCustom = !showCustom)}>
			{showCustom ? 'Close' : 'Add a custom server (advanced)'}
		</button>
		<button type="button" class="advanced" onclick={() => (showRemote = !showRemote)}>
			{showRemote ? 'Close' : 'Add a remote server (advanced)'}
		</button>
	</div>

	{#if showCatalog}
		<McpCatalogBrowser
			entries={catalog}
			{installedEntryIds}
			{runtimes}
			{progress}
			{installingId}
			oninstall={install}
			oncancel={cancelInstall}
		/>
	{/if}

	{#if showRemote}
		<div class="custom-form">
			<p class="warning">
				A remote server runs on someone else's computer and sees whatever the assistant sends it —
				including the parts of your conversation that end up in a tool call. Only add one you trust
				with that. Its tools get the same approval prompts as any other server; being remote does
				not make a tool safer.
			</p>
			<label>
				Server URL
				<input bind:value={remoteUrl} placeholder="https://mcp.example.com/mcp" />
			</label>
			<label>
				Token or API key (optional)
				<input type="password" bind:value={remoteToken} placeholder="Leave blank if none" />
			</label>
			<p class="section-help">
				Servers that require signing in through a browser are not supported yet. Requests follow
				whatever proxy you have configured under Search.
			</p>
			<button type="button" disabled={!remoteUrl.trim()} onclick={addRemote}>Add</button>
		</div>
	{/if}

	{#if showCustom}
		<div class="custom-form">
			<p class="section-help">
				Run any MCP server you already have. It gets the same tool controls and the same approval
				prompts as a catalog server — a server you configured yourself is not treated as more
				trustworthy.
			</p>
			<label>
				Program
				<input bind:value={customProgram} placeholder="/usr/local/bin/my-mcp-server" />
			</label>
			<label>
				Arguments
				<input bind:value={customArgs} placeholder="--stdio" />
			</label>
			<button type="button" disabled={!customProgram.trim()} onclick={addCustom}>Add</button>
		</div>
	{/if}
</section>

<style>
	.warning {
		border-left: 3px solid var(--warning, #d97706);
		padding-left: 0.75rem;
		font-size: 0.9em;
	}
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.9em;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.advanced {
		font-size: 0.9em;
	}
	.custom-form {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
</style>
