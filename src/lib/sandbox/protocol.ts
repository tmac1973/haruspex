// Message protocol between the main thread and the Pyodide Web Worker.
// Phase 11 — see plan/phase-11-code-sandbox.md.

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

export type MainToWorker =
	| { kind: 'set_interrupt_buffer'; buffer: SharedArrayBuffer }
	| { kind: 'run'; id: string; code: string }
	| { kind: 'install'; id: string; package: string }
	| { kind: 'reset'; id: string }
	| { kind: 'interrupt'; id: string }
	| {
			kind: 'fetch_response';
			id: string;
			request_id: string;
			ok: boolean;
			status: number;
			body: ArrayBuffer;
			headers: Record<string, string>;
	  }
	| {
			kind: 'save_response';
			id: string;
			request_id: string;
			ok: boolean;
			path?: string;
			bytes?: number;
			error?: string;
	  };

export type WorkerToMain =
	| { kind: 'ready' }
	| { kind: 'load_error'; error: string }
	| { kind: 'stdout'; id: string; data: string }
	| { kind: 'stderr'; id: string; data: string }
	| {
			kind: 'artifact';
			id: string;
			mime: string;
			payload: { kind: 'bytes'; bytes: Uint8Array } | { kind: 'text'; text: string };
			alt?: string;
			truncated?: { shown: number; total: number };
	  }
	| { kind: 'install_progress'; id: string; package: string; phase: InstallPhase }
	| { kind: 'done'; id: string; result: ToolResult }
	| { kind: 'fetch_request'; id: string; request_id: string; url: string; init: RequestInit }
	| {
			kind: 'save_request';
			id: string;
			request_id: string;
			filename: string;
			content: ArrayBuffer | string;
	  };
