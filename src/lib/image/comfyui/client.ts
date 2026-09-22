/**
 * The ComfyUI HTTP and WebSocket surface.
 *
 * Plain `fetch` and `WebSocket`, the way `src/lib/api.ts` talks to the
 * inference server — the CSP already allows `http:` and `ws:`, and routing
 * this through Rust would buy nothing.
 *
 * Every failure is mapped onto an `ImageBackendError.kind` the caller branches
 * on: a refused connection is `unreachable` and worth retrying later, a 4xx is
 * `rejected` and is not.
 */

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

function trimUrl(base: string): string {
	return base.trim().replace(/\/+$/, '');
}

function authHeaders(cfg: ClientConfig): Record<string, string> {
	// Absent rather than empty: a bare local ComfyUI has no auth, and an empty
	// Authorization header is worse than none at all.
	return cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {};
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function request(
	cfg: ClientConfig,
	path: string,
	init: RequestInit = {},
	signal?: AbortSignal
): Promise<Response> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(`${trimUrl(cfg.baseUrl)}${path}`, {
			...init,
			headers: { ...authHeaders(cfg), ...(init.headers ?? {}) },
			signal: controller.signal
		});
	} catch (e) {
		if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
		// An aborted fetch that the caller did not cancel is our own timeout.
		const timedOut = e instanceof Error && e.name === 'AbortError';
		throw new ImageBackendError(
			timedOut ? 'timeout' : 'unreachable',
			timedOut
				? `The image backend did not answer ${path} within ${HTTP_TIMEOUT_MS / 1000}s.`
				: `Could not reach the image backend at ${trimUrl(cfg.baseUrl)} — ${describe(e)}`
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new ImageBackendError('rejected', `The image backend refused ${path}.`, {
			status: res.status,
			body: body.slice(0, 200)
		});
	}
	return res;
}

/** `GET /system_stats`, for the probe. */
export async function systemStats(cfg: ClientConfig): Promise<Record<string, unknown>> {
	return (await (await request(cfg, '/system_stats')).json()) as Record<string, unknown>;
}

/** `GET /object_info/<class>`, used to check a configured checkpoint exists. */
export async function objectInfo(cfg: ClientConfig, cls: string): Promise<unknown> {
	return await (await request(cfg, `/object_info/${cls}`)).json();
}

/** Upload a reference image; returns the server-side filename to bind. */
export async function uploadImage(
	cfg: ClientConfig,
	bytes: Uint8Array,
	name: string,
	signal?: AbortSignal
): Promise<string> {
	const form = new FormData();
	form.append('image', new Blob([bytes as BlobPart], { type: 'image/png' }), name);
	form.append('overwrite', 'true');
	const res = await request(cfg, '/upload/image', { method: 'POST', body: form }, signal);
	const json = (await res.json()) as { name?: string; subfolder?: string };
	if (!json.name) {
		throw new ImageBackendError(
			'rejected',
			'The image backend accepted an upload but named no file.'
		);
	}
	return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

/** Queue a graph; returns its prompt id. */
export async function submit(
	cfg: ClientConfig,
	graph: ComfyGraph,
	clientId: string,
	signal?: AbortSignal
): Promise<string> {
	const res = await request(
		cfg,
		'/prompt',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: graph, client_id: clientId })
		},
		signal
	);
	const json = (await res.json()) as { prompt_id?: string };
	if (!json.prompt_id) {
		throw new ImageBackendError('rejected', 'The image backend queued nothing for this workflow.');
	}
	return json.prompt_id;
}

/** Stop whatever is running. Best-effort: a failure here must not mask why. */
export async function interrupt(cfg: ClientConfig): Promise<void> {
	try {
		await request(cfg, '/interrupt', { method: 'POST' });
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
	const res = await request(cfg, `/history/${promptId}`, {}, signal);
	const json = (await res.json()) as Record<
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
	const res = await request(cfg, `/view?${q}`, {}, signal);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * Progress over the WebSocket.
 *
 * The URL carries NO api key. A socket cannot send headers, and the obvious
 * workaround — a query parameter — writes the secret into server logs, proxy
 * logs and browser history. Progress is cosmetic; a secret is not. When the
 * socket is refused, the caller polls `/history` instead and reports
 * indeterminate progress.
 *
 * Returns a closer; call it when the generation ends.
 */
export function subscribe(
	cfg: ClientConfig,
	clientId: string,
	onProgress: (p: ImageProgress) => void,
	onFailure: () => void
): () => void {
	const url = `${trimUrl(cfg.baseUrl).replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
	let socket: WebSocket;
	try {
		socket = new WebSocket(url);
	} catch {
		onFailure();
		return () => {};
	}
	let idle = setTimeout(onFailure, SOCKET_IDLE_MS);
	const bump = () => {
		clearTimeout(idle);
		idle = setTimeout(onFailure, SOCKET_IDLE_MS);
	};

	socket.onmessage = (ev) => {
		bump();
		if (typeof ev.data !== 'string') return;
		try {
			const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> };
			if (msg.type === 'progress') {
				onProgress({
					phase: 'running',
					step: Number(msg.data?.value ?? 0),
					totalSteps: Number(msg.data?.max ?? 0)
				});
			} else if (msg.type === 'execution_start') {
				onProgress({ phase: 'running' });
			} else if (msg.type === 'status') {
				onProgress({ phase: 'queued' });
			}
		} catch {
			// A message shape we do not know is not a failure worth surfacing.
		}
	};
	socket.onerror = () => onFailure();
	socket.onclose = () => clearTimeout(idle);

	return () => {
		clearTimeout(idle);
		try {
			socket.close();
		} catch {
			// Already closed.
		}
	};
}
