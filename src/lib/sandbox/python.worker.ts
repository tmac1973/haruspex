/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: PyodideInterface | null = null;
let initStarted = false;
let pendingInterruptBuffer: SharedArrayBuffer | null = null;
let currentRunId = '';
let currentStdout = '';
let currentStderr = '';

function post(msg: WorkerToMain) {
	self.postMessage(msg);
}

async function init(): Promise<void> {
	if (initStarted) return;
	initStarted = true;
	try {
		// loadPyodide comes from the npm package; the .wasm / stdlib zip
		// it pulls down at runtime live in static/pyodide/ (downloaded by
		// scripts/fetch-pyodide.sh, served at /pyodide/).
		pyodide = await loadPyodide({ indexURL: '/pyodide/' });
		// Pyodide's batched callback delivers one line at a time WITHOUT
		// the trailing newline, so re-append it before forwarding. Without
		// this, `print('a'); print('b')` shows up as 'ab' instead of 'a\nb'.
		pyodide.setStdout({
			batched: (s) => {
				const line = s + '\n';
				currentStdout += line;
				if (currentRunId) post({ kind: 'stdout', id: currentRunId, data: line });
			}
		});
		pyodide.setStderr({
			batched: (s) => {
				const line = s + '\n';
				currentStderr += line;
				if (currentRunId) post({ kind: 'stderr', id: currentRunId, data: line });
			}
		});
		if (pendingInterruptBuffer) {
			pyodide.setInterruptBuffer(new Uint8Array(pendingInterruptBuffer));
			pendingInterruptBuffer = null;
		}
		post({ kind: 'ready' });
	} catch (err) {
		post({ kind: 'load_error', error: err instanceof Error ? err.message : String(err) });
	}
}

function applyInterruptBuffer(buffer: SharedArrayBuffer): void {
	if (pyodide) {
		pyodide.setInterruptBuffer(new Uint8Array(buffer));
	} else {
		pendingInterruptBuffer = buffer;
	}
}

function emptyResult(durationMs: number, error: string | null = null): ToolResult {
	const result: ToolResult = {
		stdout: currentStdout,
		stderr: currentStderr,
		result: '',
		error,
		artifacts: 0,
		notes: [],
		duration_ms: durationMs
	};
	currentStdout = '';
	currentStderr = '';
	return result;
}

async function handleRun(id: string, code: string): Promise<void> {
	if (!pyodide) {
		post({
			kind: 'done',
			id,
			result: emptyResult(0, 'Pyodide is not loaded')
		});
		return;
	}
	currentRunId = id;
	currentStdout = '';
	currentStderr = '';
	const t0 = performance.now();
	try {
		await pyodide.loadPackagesFromImports(code);
		const value = await pyodide.runPythonAsync(code);
		const result = emptyResult(Math.round(performance.now() - t0));
		result.result = value === undefined || value === null ? '' : String(value);
		post({ kind: 'done', id, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		post({
			kind: 'done',
			id,
			result: emptyResult(Math.round(performance.now() - t0), message)
		});
	} finally {
		currentRunId = '';
	}
}

async function handleInstall(id: string, packageName: string): Promise<void> {
	if (!pyodide) {
		post({
			kind: 'done',
			id,
			result: emptyResult(0, 'Pyodide is not loaded')
		});
		return;
	}
	const t0 = performance.now();
	post({ kind: 'install_progress', id, package: packageName, phase: 'resolving' });
	try {
		const micropip = pyodide.pyimport('micropip');
		post({ kind: 'install_progress', id, package: packageName, phase: 'downloading' });
		await micropip.install(packageName);
		post({ kind: 'install_progress', id, package: packageName, phase: 'installing' });
		const result = emptyResult(Math.round(performance.now() - t0));
		result.result = `installed ${packageName}`;
		post({ kind: 'done', id, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		post({
			kind: 'done',
			id,
			result: emptyResult(Math.round(performance.now() - t0), message)
		});
	}
}

self.addEventListener('message', (e: MessageEvent<MainToWorker>) => {
	const msg = e.data;
	switch (msg.kind) {
		case 'set_interrupt_buffer':
			applyInterruptBuffer(msg.buffer);
			break;
		case 'run':
			void handleRun(msg.id, msg.code);
			break;
		case 'install':
			void handleInstall(msg.id, msg.package);
			break;
		case 'reset':
			// Full reset is implemented by the manager via terminate-and-respawn.
			// Acknowledging here keeps the protocol symmetric in case we add an
			// in-process reset later.
			post({ kind: 'done', id: msg.id, result: emptyResult(0) });
			break;
		case 'interrupt':
			// Cooperative interrupt is delivered through the SharedArrayBuffer;
			// this message is reserved for future use (e.g. cancelling network
			// fetches that don't see the bytecode interrupt).
			break;
		case 'fetch_response':
		case 'save_response':
			// Bridges resolved by their own pending-promise tables in 11.5/11.5b.
			break;
	}
});

void init();
