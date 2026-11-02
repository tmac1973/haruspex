/**
 * Updating an installed catalog server to the version the catalog now pins.
 *
 * Rust does the file work (`update.rs`): stage the new version beside the
 * running one, swap it in carrying the user's files across, then keep it or put
 * the old one back. This module owns the order, because the parts between the
 * swap and the decision — setup steps that belong to the package version, the
 * Godot addon in each project, the handshake that proves the new version works
 * — already run from the frontend.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CatalogEntry } from '#lib/ipc/gen/CatalogEntry.ts';
import type { DownloadProgress } from '#lib/ipc/gen/DownloadProgress.ts';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import type { McpUpdateStatus } from '#lib/ipc/gen/McpUpdateStatus.ts';
import { unregisterMcpServer } from '#lib/agent/tools/mcp.ts';
import { persistItem } from '#lib/persist.ts';
import { forgetServerApprovals } from '#lib/stores/mcpApproval.svelte.ts';
import {
	installedManifest,
	loadInstalledManifests,
	mcpState,
	refreshMcpTools,
	startConfiguredMcpServers,
	startMcpServer,
	stopMcpServer
} from '#lib/stores/mcpServers.svelte.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { openSettings } from '#lib/stores/settingsNav.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';

const INSTALL_PROGRESS_EVENT = 'mcp-install-progress';

/** What the row says after an update, and the detail behind it. */
export interface UpdateResult {
	ok: boolean;
	text: string;
	detail: string | null;
}

/** The update in flight: one at a time, app-wide. */
interface Running {
	serverId: string;
	stage: string;
	progress: DownloadProgress | null;
}

const statuses = $state<Record<string, McpUpdateStatus>>({});
const results = $state<Record<string, UpdateResult>>({});
let running = $state<Running | null>(null);

export function mcpUpdateStatus(serverId: string): McpUpdateStatus | null {
	return statuses[serverId] ?? null;
}

export function mcpUpdateResult(serverId: string): UpdateResult | null {
	return results[serverId] ?? null;
}

export function runningMcpUpdate(): Running | null {
	return running;
}

/** Ask Rust where each catalog server stands against its pin. */
export async function refreshUpdateStatuses(servers: McpServerConfig[]): Promise<void> {
	const catalogServers = servers.filter((s) => s.source.kind === 'catalog');
	try {
		const found =
			catalogServers.length === 0
				? []
				: await invoke<McpUpdateStatus[]>('mcp_update_status', { servers: catalogServers });
		for (const id of Object.keys(statuses)) delete statuses[id];
		for (const status of found ?? []) statuses[status.serverId] = status;
	} catch (e) {
		console.warn('mcp: could not read update status:', errMessage(e));
	}
}

/**
 * Undo any update a previous run of the app left half done. Before any server
 * starts, so none is launched from a folder caught mid-swap.
 */
export async function recoverInterruptedUpdates(): Promise<void> {
	try {
		const restored = await invoke<string[]>('mcp_update_recover');
		if (restored?.length) {
			showToast('An MCP server update was interrupted and has been undone.', { kind: 'error' });
		}
	} catch (e) {
		console.warn('mcp: could not check for interrupted updates:', errMessage(e));
	}
}

/** The pin each server was last told about, so a new pin toasts once. */
const NOTIFIED_KEY = 'haruspex.mcp.updateNotified';

function loadNotified(): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}');
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
	} catch {
		// Unreadable means the toast may show again, never that it is lost.
		return {};
	}
}

function saveNotified(notified: Record<string, string>): void {
	try {
		persistItem(NOTIFIED_KEY, JSON.stringify(notified));
	} catch {
		// As above: at worst, one more toast.
	}
}

/** Forget what a removed server was told, so a reinstall starts fresh. */
export function forgetUpdateNotice(serverId: string): void {
	const notified = loadNotified();
	if (!(serverId in notified)) return;
	delete notified[serverId];
	saveNotified(notified);
}

/** Servers with an update or a blocked version: the Settings rail's badge. */
export function mcpAttentionCount(): number {
	return Object.values(statuses).filter((s) => s.updateAvailable || s.blockedReason !== null)
		.length;
}

const openMcpSettings = (): void => openSettings('mcp');

/**
 * Tell the user what the statuses say. A blocked version on every launch,
 * because it stays stopped until updated; a new pin once, because the badge
 * carries it from there.
 */
export function notifyUpdates(servers: McpServerConfig[]): void {
	const all = Object.values(statuses);

	const blocked = all.filter((s) => s.blockedReason !== null);
	if (blocked.length === 1) {
		const name = servers.find((s) => s.id === blocked[0].serverId)?.label ?? 'An MCP server';
		showToast(`${name} was stopped for a security problem: ${blocked[0].blockedReason}`, {
			kind: 'error',
			actionLabel: 'Open',
			onAction: openMcpSettings
		});
	} else if (blocked.length > 1) {
		showToast(
			`${blocked.length} MCP servers were stopped for security problems. Settings → MCP servers.`,
			{ kind: 'error', actionLabel: 'Open', onAction: openMcpSettings }
		);
	}

	const notified = loadNotified();
	const fresh = all.filter(
		(s) => s.updateAvailable && s.blockedReason === null && notified[s.serverId] !== s.pinnedVersion
	);
	if (fresh.length === 0) return;
	showToast(
		fresh.length === 1
			? '1 MCP server has an update. Settings → MCP servers.'
			: `${fresh.length} MCP servers have updates. Settings → MCP servers.`,
		{ actionLabel: 'Open', onAction: openMcpSettings }
	);
	for (const s of fresh) notified[s.serverId] = s.pinnedVersion;
	saveNotified(notified);
}

/**
 * Launch: put interrupted updates right, learn what has an update, then start
 * the servers that should be running. Skipped entirely when no MCP server is
 * configured, so a fresh install pays nothing for the feature.
 */
export async function startMcpAtLaunch(): Promise<void> {
	const servers = getSettings().integrations.mcp.servers;
	if (servers.length > 0) {
		await recoverInterruptedUpdates();
		await refreshUpdateStatuses(servers);
		notifyUpdates(servers);
	}
	await startConfiguredMcpServers();
}

/** The recorded addon projects that still exist, for the row to confirm. */
export async function existingAddonProjects(config: McpServerConfig): Promise<string[]> {
	const projects = config.addonProjects ?? [];
	if (projects.length === 0) return [];
	try {
		return await invoke<string[]>('mcp_existing_dirs', { paths: projects });
	} catch {
		// Better to try them all and report a failure than to drop one that
		// is there.
		return projects;
	}
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "Updated to X. 2 tools added, 1 removed. Approvals were reset." */
export function updatedText(
	version: string,
	before: string[] | null,
	after: string[] | null
): UpdateResult {
	if (!before || !after) {
		return { ok: true, text: `Updated to ${version}. Approvals were reset.`, detail: null };
	}
	const added = after.filter((t) => !before.includes(t));
	const removed = before.filter((t) => !after.includes(t));
	const parts = [
		added.length ? plural(added.length, 'tool added', 'tools added') : null,
		removed.length ? `${removed.length} removed` : null
	].filter((p): p is string => p !== null);
	const detail = [
		added.length ? `Added: ${added.join(', ')}` : null,
		removed.length ? `Removed: ${removed.join(', ')}` : null
	]
		.filter((p): p is string => p !== null)
		.join('\n');
	return {
		ok: true,
		text: `Updated to ${version}. ${parts.length ? `${parts.join(', ')}. ` : ''}Approvals were reset.`,
		detail: detail || null
	};
}

/** One update, with what it needs to remember about the server before it. */
interface Attempt {
	config: McpServerConfig;
	entry: CatalogEntry;
	id: string;
	entryId: string;
	proxy: ReturnType<typeof getSettings>['proxy'];
	wasRunning: boolean;
	/** Stopped only by its version's block, so it should be up afterwards. */
	wasBlocked: boolean;
	toolsBefore: string[] | null;
	oldVersion: string;
	/**
	 * A setup step that belongs to the package version has started. It may
	 * have replaced what the old version relied on — Playwright's browser
	 * download deletes the browser no install links to any more — so a
	 * rollback after it runs the old version's steps again.
	 */
	setupStarted: boolean;
}

function setStage(id: string, stage: string): void {
	running = { serverId: id, stage, progress: null };
}

function failed(a: Attempt, e: unknown): UpdateResult {
	return {
		ok: false,
		text: `Update failed; version ${a.oldVersion} is still installed.`,
		detail: errMessage(e)
	};
}

/**
 * Withdraw the server's tools so no new call can start, then look for one
 * already under way: stopping now would cut it off. On false, the tools are
 * back and the staged install is gone.
 */
async function quiesce(a: Attempt): Promise<boolean> {
	unregisterMcpServer(a.id);
	const inFlight = await invoke<number>('mcp_calls_in_flight', { serverId: a.id });
	if (inFlight === 0) return true;
	if (a.wasRunning) await refreshMcpTools(a.id);
	await invoke('mcp_update_rollback', { serverId: a.id });
	results[a.id] = {
		ok: false,
		text: 'A tool from this server is running. Try again when it finishes.',
		detail: null
	};
	return false;
}

/** The setup that belongs to the package version: flagged steps, addons. */
async function rerunSetup(a: Attempt): Promise<void> {
	for (const step of a.entry.setup) {
		if (step.kind !== 'command' || !step.onUpdate) continue;
		setStage(a.id, `${step.label}…`);
		a.setupStarted = true;
		await invoke('mcp_run_setup_command', { config: a.config, args: step.args, proxy: a.proxy });
	}
	for (const [stepIndex, step] of a.entry.setup.entries()) {
		if (step.kind !== 'addon') continue;
		for (const targetDir of a.config.addonProjects ?? []) {
			setStage(a.id, 'Updating the addon…');
			await invoke('mcp_install_addon', {
				entryId: a.entryId,
				stepIndex,
				targetDir,
				proxy: a.proxy
			});
		}
	}
}

/**
 * Prove the new version starts, when the server is meant to run at all.
 * Returns its tool names, or null when it was not started. Throws when it
 * did not come up.
 */
async function checkItStarts(a: Attempt): Promise<string[] | null> {
	if (!a.config.enabled || !a.config.setupComplete) return null;
	setStage(a.id, 'Starting…');
	await startMcpServer(a.config, a.entry);
	const after = mcpState(a.id);
	if (after.status.type !== 'Ready') {
		throw new Error(after.error ?? after.blockedReason ?? 'it did not start');
	}
	// A server that was only stopped by its block stays up: the update was
	// the thing it was waiting for.
	if (!a.wasRunning && !a.wasBlocked) await stopMcpServer(a.id);
	return after.tools.map((t) => t.name);
}

/** Swap the staged version in and keep it, or put the old one back. */
async function swapIn(a: Attempt): Promise<void> {
	try {
		await stopMcpServer(a.id);
		await invoke('mcp_update_swap', { entryId: a.entryId, serverId: a.id });
		await loadInstalledManifests([a.config]);
		await rerunSetup(a);
		const toolsAfter = await checkItStarts(a);
		await invoke('mcp_update_commit', { serverId: a.id });
		forgetServerApprovals(a.id);
		results[a.id] = updatedText(a.entry.acquisition.version, a.toolsBefore, toolsAfter);
	} catch (e) {
		results[a.id] = failed(a, e);
		await putBack(a, e);
	}
}

/**
 * Run the restored version's own package-version steps again, from its
 * manifest: the update's ran for the new version and may have taken away
 * what the old one needs. Returns why it could not, or null.
 */
async function redoSetup(a: Attempt): Promise<string | null> {
	const steps = installedManifest(a.id)?.entry.setup ?? [];
	for (const step of steps) {
		if (step.kind !== 'command' || !step.onUpdate) continue;
		setStage(a.id, `${step.label}…`);
		try {
			await invoke('mcp_run_setup_command', { config: a.config, args: step.args, proxy: a.proxy });
		} catch (e) {
			return errMessage(e);
		}
	}
	return null;
}

async function putBack(a: Attempt, cause: unknown): Promise<void> {
	try {
		await stopMcpServer(a.id);
		await invoke('mcp_update_rollback', { serverId: a.id });
		await loadInstalledManifests([a.config]);
		const redoFailed = a.setupStarted ? await redoSetup(a) : null;
		if (redoFailed !== null) {
			results[a.id] = {
				ok: false,
				text: `Update failed; version ${a.oldVersion} is back, but its setup needs running again (Setup).`,
				detail: `${errMessage(cause)}\n${redoFailed}`
			};
		}
		if (a.wasRunning) await startMcpServer(a.config, a.entry);
	} catch (undo) {
		results[a.id] = {
			ok: false,
			text: 'Update failed, and the old version could not be put back. Remove the server and add it again.',
			detail: `${errMessage(cause)}\n${errMessage(undo)}`
		};
	}
}

/**
 * Update one server to the version its catalog entry pins.
 *
 * The old version keeps running while the new one downloads. After the swap,
 * any failure — a setup step, an addon, a new version that will not start —
 * puts the old one back and restarts it if it was running. `config` carries
 * the addon projects to update, already narrowed to the ones that exist.
 */
export async function updateMcpServer(config: McpServerConfig, entry: CatalogEntry): Promise<void> {
	if (running || config.source.kind !== 'catalog') return;
	const before = mcpState(config.id);
	const a: Attempt = {
		config,
		entry,
		id: config.id,
		entryId: config.source.entryId,
		proxy: getSettings().proxy,
		wasRunning: before.status.type === 'Ready',
		wasBlocked: before.blockedReason !== null,
		toolsBefore: before.status.type === 'Ready' ? before.tools.map((t) => t.name) : null,
		oldVersion: statuses[config.id]?.installedVersion ?? 'the old version',
		setupStarted: false
	};

	delete results[a.id];
	setStage(a.id, 'Downloading…');
	const unlisten = await listen<DownloadProgress>(INSTALL_PROGRESS_EVENT, (e) => {
		if (running?.serverId === a.id) running.progress = e.payload;
	});
	try {
		try {
			await invoke('mcp_update_stage', { entryId: a.entryId, serverId: a.id, proxy: a.proxy });
		} catch (e) {
			// Nothing was stopped or moved yet.
			results[a.id] = failed(a, e);
			return;
		}
		setStage(a.id, 'Installing…');
		if (await quiesce(a)) await swapIn(a);
	} finally {
		unlisten();
		running = null;
		await refreshUpdateStatuses(getSettings().integrations.mcp.servers);
	}
}
