// Message protocol between the SvelteKit main thread and the workspace
// iframe that hosts Pyodide for the unified python sandbox. The shapes
// mirror the legacy worker protocol (src/lib/sandbox/protocol.ts) — the
// transport is the only thing that changes (postMessage to/from the
// iframe's contentWindow, not a Web Worker). After step 9 the legacy
// protocol file is deleted and this file moves into src/lib/sandbox/.
//
// Two facts shape the design:
//
//   1. window.__TAURI_INTERNALS__ is NOT injected into child iframes on
//      Tauri 2.x / WebKitGTK (verified on the prior phase-13 branch).
//      The iframe therefore cannot invoke Rust commands directly; every
//      sandbox_fetch / sandbox_save / sandbox_delete / sandbox_sync
//      call routes through the parent via fetch_request/fetch_response
//      etc. message pairs.
//   2. The iframe owns its own DOM stage (a <div id="stage"> + canvas).
//      stage_write / stage_clear events tell the parent that fresh
//      visual content landed so it can auto-switch the active tab.

export type InstallPhase = 'resolving' | 'downloading' | 'installing';

export type Artifact =
	| { kind: 'image'; mime: string; dataUrl: string; alt?: string }
	| { kind: 'html'; html: string; truncated?: { shown: number; total: number } };

export interface ToolResult {
	stdout: string;
	stderr: string;
	result: string;
	error: string | null;
	artifacts: number;
	artifactsList: Artifact[];
	notes: string[];
	duration_ms: number;
}

export interface SyncFile {
	path: string;
	abs_path: string;
	bytes: Uint8Array;
	mtime: number;
}

export interface SyncSkipped {
	path: string;
	reason: string;
}

export type MainToIframe =
	| { kind: 'set_interrupt_buffer'; buffer: SharedArrayBuffer }
	| { kind: 'runtime_config'; proxyMode: string; workingDirSet: boolean }
	| {
			kind: 'sync_workdir_files';
			sync_id: string;
			workdir_abs: string;
			to_sync: SyncFile[];
			deleted: string[];
			skipped: SyncSkipped[];
	  }
	| { kind: 'run'; id: string; code: string }
	| { kind: 'install'; id: string; package: string }
	| { kind: 'reset'; id: string }
	| { kind: 'interrupt'; id: string }
	| { kind: 'capture_snapshot'; request_id: string }
	| {
			kind: 'fetch_response';
			id: string;
			request_id: string;
			ok: boolean;
			status: number;
			headers: Record<string, string>;
			body: Uint8Array;
			url: string;
			error?: string;
	  }
	| {
			kind: 'save_response';
			id: string;
			request_id: string;
			ok: boolean;
			path?: string;
			bytes?: number;
			error?: string;
	  }
	| {
			kind: 'delete_response';
			id: string;
			request_id: string;
			ok: boolean;
			path?: string;
			error?: string;
	  };

export type IframeToMain =
	| { kind: 'ready' }
	| { kind: 'load_error'; error: string }
	| { kind: 'get_runtime_config' }
	| { kind: 'sync_workdir_ack'; sync_id: string; error?: string }
	| { kind: 'stdout'; id: string | null; data: string }
	| { kind: 'stderr'; id: string | null; data: string }
	| {
			kind: 'artifact';
			id: string;
			mime: string;
			payload: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'text'; text: string };
			alt?: string;
			truncated?: { shown: number; total: number };
	  }
	| { kind: 'stage_write' }
	| { kind: 'stage_clear' }
	| { kind: 'install_progress'; id: string; package: string; phase: InstallPhase }
	| { kind: 'done'; id: string; result: ToolResult }
	| {
			kind: 'snapshot';
			request_id: string;
			mime: 'image/png' | 'text/html';
			payload: string;
	  }
	| {
			kind: 'fetch_request';
			id: string;
			request_id: string;
			url: string;
			init: {
				method?: string;
				headers?: Record<string, string>;
				body?: Uint8Array;
			};
	  }
	| {
			kind: 'save_request';
			id: string;
			request_id: string;
			filename: string;
			content: Uint8Array | ArrayBuffer | string;
	  }
	| {
			kind: 'delete_request';
			id: string;
			request_id: string;
			filename: string;
	  };
