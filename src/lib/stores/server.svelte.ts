import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type ServerStatusType = 'stopped' | 'starting' | 'ready' | 'error';

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
}

// Svelte 5 runes-based state
let serverState = $state<ServerState>({
	status: 'stopped',
	errorMessage: undefined,
	port: 8765
});

function parseStatusEvent(payload: RustServerStatus): void {
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
