import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Server status visible to the UI. The first four mirror the Rust-side
 * llama-server lifecycle (see Rust `ServerStatus` enum); `'remote'` is
 * a frontend-only synthetic state meaning "we're not running a local
 * sidecar right now — chat requests go to the configured remote URL".
 * It's set when the user flips the inference backend to remote mode
 * and cleared when they flip back (at which point the real local
 * lifecycle resumes from `'stopped'` → `'starting'` → `'ready'`).
 */
export type ServerStatusType = 'stopped' | 'starting' | 'ready' | 'error' | 'remote';

// Matches the Rust enum serialization: #[serde(tag = "type", content = "message")]
type RustServerStatus =
	| { type: 'Stopped' }
	| { type: 'Starting' }
	| { type: 'Ready' }
	| { type: 'Error'; message: string };

export interface ServerState {
	status: ServerStatusType;
	errorMessage?: string;
	port: number;
	/**
	 * Display label shown next to the status indicator. For local mode
	 * this is the default port; for remote mode it's set to the short
	 * form of the configured base URL so the user can tell at a glance
	 * where their chat requests are going.
	 */
	remoteLabel?: string;
}

// Svelte 5 runes-based state
let serverState = $state<ServerState>({
	status: 'stopped',
	errorMessage: undefined,
	port: 8765
});

function parseStatusEvent(payload: RustServerStatus): void {
	// When the UI is in remote-inference mode the local llama-server sidecar
	// is intentionally not running, so Rust will keep reporting `Stopped`.
	// Ignore those updates — the user only leaves remote mode through the
	// explicit `exitRemoteMode()` path. Without this guard, an unawaited
	// `initServerStore()` racing against the layout's settings check would
	// flip the badge from 'remote' back to 'stopped' shortly after startup.
	if (serverState.status === 'remote' && payload.type === 'Stopped') return;
	serverState.status = payload.type.toLowerCase() as ServerStatusType;
	serverState.errorMessage = payload.type === 'Error' ? payload.message : undefined;
}

let listenerInitialized = false;

export async function initServerStore(): Promise<void> {
	if (listenerInitialized) return;
	listenerInitialized = true;

	// Sync initial state
	try {
		const status = await invoke<RustServerStatus>('get_server_status');
		parseStatusEvent(status);
	} catch {
		// Server command may not be available yet
	}

	// Listen for status changes
	await listen<RustServerStatus>('server-status-changed', (event) => {
		parseStatusEvent(event.payload);
	});
}

export async function startServer(
	modelPath: string,
	ctxSize?: number,
	extraArgs?: string[]
): Promise<void> {
	serverState.status = 'starting';
	serverState.errorMessage = undefined;
	try {
		await invoke('start_server', {
			modelPath,
			ctxSize: ctxSize || null,
			extraArgs: extraArgs || null
		});
	} catch (e) {
		serverState.status = 'error';
		serverState.errorMessage = String(e);
	}
}

export async function stopServer(): Promise<void> {
	try {
		await invoke('stop_server');
		serverState.status = 'stopped';
		serverState.errorMessage = undefined;
	} catch (e) {
		serverState.errorMessage = String(e);
	}
}

/**
 * Transition the UI into remote-inference mode. Does NOT talk to the
 * Rust side — the actual `stop_server` invocation is the caller's
 * responsibility (it's done separately because the caller usually
 * wants to wait for stop to finish before flipping the status label).
 * Callers: the Settings page mode-toggle handler and the first-run
 * wizard's "Connect to remote" branch.
 */
export function enterRemoteMode(label: string): void {
	serverState.status = 'remote';
	serverState.errorMessage = undefined;
	serverState.remoteLabel = label;
}

/**
 * Leave remote-inference mode without starting anything. Resets the
 * status to 'stopped' so the caller can then invoke startServer() for
 * the local sidecar if appropriate.
 */
export function exitRemoteMode(): void {
	serverState.remoteLabel = undefined;
	if (serverState.status === 'remote') {
		serverState.status = 'stopped';
	}
}

export async function getServerLogs(): Promise<string[]> {
	try {
		return await invoke<string[]>('get_server_logs');
	} catch {
		return [];
	}
}

export function getServerState(): ServerState {
	return serverState;
}
