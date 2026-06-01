// Message protocol between the main thread and the Pyodide Web Worker.
// Phase 11 — see plan/phase-11-code-sandbox.md.

export type InstallPhase = 'resolving' | 'downloading' | 'installing';

export type Artifact =
	| { kind: 'image'; mime: string; dataUrl: string; alt?: string }
	| {
			kind: 'html';
			html: string;
			truncated?: { shown: number; total: number };
			/** When true the chat renders this artifact inside a sandboxed
			 *  iframe (srcdoc) so embedded <script> tags execute as part of
			 *  a normal document load. Used for plotly / bokeh / altair
			 *  output. Plain HTML (DataFrame tables) leaves this unset and
			 *  renders via {@html ...}. */
			interactive?: boolean;
	  };

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

export type MainToWorker =
	| { kind: 'set_interrupt_buffer'; buffer: SharedArrayBuffer }
	| { kind: 'proxy_mode'; mode: string; workingDirSet: boolean }
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
	| { kind: 'list_globals'; id: string }
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

export type WorkerToMain =
	| { kind: 'ready' }
	| { kind: 'load_error'; error: string }
	| { kind: 'get_proxy_mode' }
	| { kind: 'sync_workdir_ack'; sync_id: string; error?: string }
	| { kind: 'stdout'; id: string; data: string }
	| { kind: 'stderr'; id: string; data: string }
	| {
			kind: 'artifact';
			id: string;
			mime: string;
			payload: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'text'; text: string };
			alt?: string;
			truncated?: { shown: number; total: number };
			interactive?: boolean;
	  }
	| { kind: 'install_progress'; id: string; package: string; phase: InstallPhase }
	| { kind: 'done'; id: string; result: ToolResult }
	| { kind: 'globals'; id: string; names: string[] }
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
