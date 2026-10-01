/**
 * The ComfyUI HTTP and WebSocket surface.
 *
 * In the app every call goes through Rust (`src-tauri/src/comfy.rs`). A
 * request from the webview carries an `Origin`, which ComfyUI's origin check
 * rejects on loopback and a remote server answers without CORS headers — so a
 * stock ComfyUI failed with "Load failed" unless it was started with
 * `--enable-cors-header`. From Rust there is no `Origin`, and the progress
 * socket can send the API key as a header, which a browser socket cannot.
 *
 * Outside the app — unit tests, and the opt-in live tests under Node — there
 * is no Rust to call, so the same calls go through `fetch` and `WebSocket`.
 * Node sends no `Origin` either.
 *
 * Every failure is mapped onto an `ImageBackendError.kind` the caller branches
 * on: a refused connection is `unreachable` and worth retrying later, a 4xx is
 * `rejected` and is not.
 */

import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { ComfyError } from '$lib/ipc/gen/ComfyError';
import type { ComfySocketEvent } from '$lib/ipc/gen/ComfySocketEvent';
import { ImageBackendError, type ImageProgress } from '../types';
import type { ComfyGraph } from './fieldMap';

/** One HTTP call. Generous: a busy server queues. */
export const HTTP_TIMEOUT_MS = 120_000;
/** Silence on the progress socket before we stop believing in it. */
export const SOCKET_IDLE_MS = 300_000;
/** One end-to-end generation, queue time included. */
export const GENERATION_TIMEOUT_MS = 600_000;
/** Fallback poll interval when the socket is unavailable. */
export const HISTORY_POLL_MS = 2_000;

export interface ClientConfig {
	baseUrl: string;
	apiKey: string;
}

export interface HistoryImage {
	filename: string;
	subfolder: string;
	type: string;
}

/** One call, whichever way it goes. */
interface Call {
	path: string;
	method?: 'GET' | 'POST';
	/** Sent as JSON. */
	body?: unknown;
}

function trimUrl(base: string): string {
	return base.trim().replace(/\/+$/, '');
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---- Through Rust (the app) -------------------------------------------------

let nextId = 0;

/** Map a `ComfyError` from Rust onto the kinds callers branch on. */
function fromRust(e: unknown, path: string, signal?: AbortSignal): ImageBackendError {
	const err = (e !== null && typeof e === 'object' && 'kind' in e ? e : null) as ComfyError | null;
	switch (err?.kind) {
		case 'cancelled':
			return new ImageBackendError('cancelled', 'Generation cancelled.');
		case 'timeout':
		case 'unreachable':
			return new ImageBackendError(err.kind, err.message);
		case 'rejected':
			return new ImageBackendError('rejected', `The image backend refused ${path}.`, {
				status: err.status,
				body: err.body
			});
		default:
			// Not ours: an IPC failure, or a cancel that raced the answer.
			if (signal?.aborted) return new ImageBackendError('cancelled', 'Generation cancelled.');
			return new ImageBackendError(
				'unreachable',
				`The request to the image backend failed — ${describe(e)}`
			);
	}
}

async function viaRust<T>(
	command: 'comfy_json' | 'comfy_bytes',
	cfg: ClientConfig,
	call: Call,
	signal?: AbortSignal
): Promise<T> {
	if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
	const id = `comfy-${++nextId}`;
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<T>(command, {
			call: {
				base_url: cfg.baseUrl,
				api_key: cfg.apiKey,
				method: call.method ?? 'GET',
				path: call.path,
				body: call.body ?? null,
				timeout_ms: HTTP_TIMEOUT_MS,
				id
			}
		});
	} catch (e) {
		throw fromRust(e, call.path, signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

// ---- Through fetch (tests, Node) --------------------------------------------

function authHeaders(cfg: ClientConfig): Record<string, string> {
	// Absent rather than empty: a bare local ComfyUI has no auth, and an empty
	// Authorization header is worse than none at all.
	return cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {};
}

async function viaFetch(cfg: ClientConfig, call: Call, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(`${trimUrl(cfg.baseUrl)}${call.path}`, {
			method: call.method ?? 'GET',
			headers: {
				...authHeaders(cfg),
				...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {})
			},
			body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
			signal: controller.signal
		});
	} catch (e) {
		if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
		// An aborted fetch that the caller did not cancel is our own timeout.
		const timedOut = e instanceof Error && e.name === 'AbortError';
		throw new ImageBackendError(
			timedOut ? 'timeout' : 'unreachable',
			timedOut
				? `The image backend did not answer ${call.path} within ${HTTP_TIMEOUT_MS / 1000}s.`
				: `Could not reach the image backend at ${trimUrl(cfg.baseUrl)} — ${describe(e)}`
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new ImageBackendError('rejected', `The image backend refused ${call.path}.`, {
			status: res.status,
			body: body.slice(0, 200)
		});
	}
	return res;
}

// ---- Either -----------------------------------------------------------------

/** A call whose answer is JSON. Text comes back as a string, nothing as null. */
export async function requestJson(
	cfg: ClientConfig,
	call: Call,
	signal?: AbortSignal
): Promise<unknown> {
	if (isTauri()) return viaRust<unknown>('comfy_json', cfg, call, signal);
	const text = await (await viaFetch(cfg, call, signal)).text();
	if (text.trim() === '') return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function requestBytes(
	cfg: ClientConfig,
	call: Call,
	signal?: AbortSignal
): Promise<Uint8Array> {
	if (isTauri()) {
		return new Uint8Array(await viaRust<ArrayBuffer>('comfy_bytes', cfg, call, signal));
	}
	return new Uint8Array(await (await viaFetch(cfg, call, signal)).arrayBuffer());
}

/** `GET /system_stats`, for the probe. */
export async function systemStats(cfg: ClientConfig): Promise<Record<string, unknown>> {
	return ((await requestJson(cfg, { path: '/system_stats' })) ?? {}) as Record<string, unknown>;
}

/** `GET /object_info/<class>`, used to check a configured checkpoint exists. */
export async function objectInfo(cfg: ClientConfig, cls: string): Promise<unknown> {
	return await requestJson(cfg, { path: `/object_info/${cls}` });
}

/** Queue a graph; returns its prompt id. */
export async function submit(
	cfg: ClientConfig,
	graph: ComfyGraph,
	clientId: string,
	signal?: AbortSignal
): Promise<string> {
	const json = (await requestJson(
		cfg,
		{ path: '/prompt', method: 'POST', body: { prompt: graph, client_id: clientId } },
		signal
	)) as { prompt_id?: string } | null;
	if (!json?.prompt_id) {
		throw new ImageBackendError('rejected', 'The image backend queued nothing for this workflow.');
	}
	return json.prompt_id;
}

/** Stop whatever is running. Best-effort: a failure here must not mask why. */
export async function interrupt(cfg: ClientConfig): Promise<void> {
	try {
		await requestJson(cfg, { path: '/interrupt', method: 'POST' });
	} catch {
		// The run is already ending; a failed interrupt changes nothing.
	}
}

/** The output images a finished prompt produced, or null while it is running. */
export async function history(
	cfg: ClientConfig,
	promptId: string,
	outputNode: string,
	signal?: AbortSignal
): Promise<HistoryImage[] | null> {
	const json = ((await requestJson(cfg, { path: `/history/${promptId}` }, signal)) ?? {}) as Record<
		string,
		{ outputs?: Record<string, { images?: HistoryImage[] }> }
	>;
	const run = json[promptId];
	if (!run?.outputs) return null;
	const images = run.outputs[outputNode]?.images;
	if (!images) {
		throw new ImageBackendError(
			'rejected',
			`The workflow finished but node "${outputNode}" produced no images — is it the SaveImage node?`
		);
	}
	return images;
}

/** Fetch one output image's bytes. */
export async function view(
	cfg: ClientConfig,
	img: HistoryImage,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const q = new URLSearchParams({
		filename: img.filename,
		subfolder: img.subfolder ?? '',
		type: img.type ?? 'output'
	});
	return requestBytes(cfg, { path: `/view?${q}` }, signal);
}

/** What one socket message means for progress, if anything. */
function progressOf(
	type: string,
	value?: number | null,
	max?: number | null
): ImageProgress | null {
	if (type === 'progress') {
		return { phase: 'running', step: Number(value ?? 0), totalSteps: Number(max ?? 0) };
	}
	if (type === 'execution_start') return { phase: 'running' };
	if (type === 'status') return { phase: 'queued' };
	return null;
}

/**
 * Progress over the WebSocket.
 *
 * Through Rust the key goes in an `Authorization` header. A browser socket
 * cannot send headers, and the obvious workaround — a query parameter — writes
 * the secret into server logs, proxy logs and browser history; so outside the
 * app the socket goes without it, and a server that requires it is polled
 * instead. Progress is cosmetic; a secret is not.
 *
 * Returns a closer; call it when the generation ends.
 */
export function subscribe(
	cfg: ClientConfig,
	clientId: string,
	onProgress: (p: ImageProgress) => void,
	onFailure: () => void
): () => void {
	let idle = setTimeout(onFailure, SOCKET_IDLE_MS);
	const bump = () => {
		clearTimeout(idle);
		idle = setTimeout(onFailure, SOCKET_IDLE_MS);
	};
	return isTauri()
		? subscribeViaRust(cfg, clientId, onProgress, onFailure, bump, () => clearTimeout(idle))
		: subscribeViaSocket(cfg, clientId, onProgress, onFailure, bump, () => clearTimeout(idle));
}

function subscribeViaRust(
	cfg: ClientConfig,
	clientId: string,
	onProgress: (p: ImageProgress) => void,
	onFailure: () => void,
	bump: () => void,
	stopIdle: () => void
): () => void {
	const id = `comfy-ws-${++nextId}`;
	const channel = new Channel<ComfySocketEvent>();
	channel.onmessage = (ev) => {
		if (ev.kind === 'closed') {
			stopIdle();
			return;
		}
		bump();
		const p = progressOf(ev.type, ev.value, ev.max);
		if (p) onProgress(p);
	};
	invoke('comfy_subscribe', {
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey,
		clientId,
		id,
		channel
	}).catch(() => {
		stopIdle();
		onFailure();
	});
	return () => {
		stopIdle();
		void invoke('comfy_cancel', { id }).catch(() => {});
	};
}

function subscribeViaSocket(
	cfg: ClientConfig,
	clientId: string,
	onProgress: (p: ImageProgress) => void,
	onFailure: () => void,
	bump: () => void,
	stopIdle: () => void
): () => void {
	const url = `${trimUrl(cfg.baseUrl).replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
	let socket: WebSocket;
	try {
		socket = new WebSocket(url);
	} catch {
		stopIdle();
		onFailure();
		return () => {};
	}
	socket.onmessage = (ev) => {
		bump();
		if (typeof ev.data !== 'string') return;
		try {
			const msg = JSON.parse(ev.data) as {
				type?: string;
				data?: { value?: number; max?: number };
			};
			const p = msg.type ? progressOf(msg.type, msg.data?.value, msg.data?.max) : null;
			if (p) onProgress(p);
		} catch {
			// A message shape we do not know is not a failure worth surfacing.
		}
	};
	socket.onerror = () => onFailure();
	socket.onclose = () => stopIdle();

	return () => {
		stopIdle();
		try {
			socket.close();
		} catch {
			// Already closed.
		}
	};
}
