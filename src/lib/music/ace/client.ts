/**
 * Calls to an ace-server, made from Rust (`ace_json`): it answers no CORS
 * preflight, so the webview could not call it directly. Errors come back as
 * {@link MusicBackendError}s.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import type { ComfyError } from '#lib/ipc/gen/ComfyError.ts';
import { MusicBackendError } from '#lib/music/types.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { errorOf } from '#lib/music/ace/adapter.ts';

const TIMEOUT_MS = 30_000;
/** A song can be tens of megabytes; the job itself is only queued. */
const UPLOAD_TIMEOUT_MS = 120_000;

let nextId = 0;

function fromRust(e: unknown, path: string, signal?: AbortSignal): MusicBackendError {
	const err = (e !== null && typeof e === 'object' && 'kind' in e ? e : null) as ComfyError | null;
	switch (err?.kind) {
		case 'cancelled':
			return new MusicBackendError('cancelled', 'Cancelled.');
		case 'timeout':
		case 'unreachable':
			return new MusicBackendError(err.kind, err.message);
		case 'invalid':
			return new MusicBackendError('rejected', err.message);
		case 'rejected': {
			const why = errorOf(err.body) ?? `status ${err.status}`;
			return new MusicBackendError('rejected', `ace-server refused ${path}: ${why}`, {
				status: err.status
			});
		}
		default:
			if (signal?.aborted) return new MusicBackendError('cancelled', 'Cancelled.');
			return new MusicBackendError(
				'unreachable',
				`The request to ace-server failed — ${errMessage(e)}`
			);
	}
}

/**
 * A call to ace-server. With `files` it is a multipart POST (`ace_upload`):
 * the body in a `request` part and each song in its own.
 */
export async function aceJson(
	baseUrl: string,
	req: { method?: 'GET' | 'POST'; path: string; body?: unknown },
	signal?: AbortSignal,
	files?: UploadFile[]
): Promise<unknown> {
	if (signal?.aborted) throw new MusicBackendError('cancelled', 'Cancelled.');
	const id = `ace-${++nextId}`;
	// The cancel table is shared with the image servers' calls.
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const call = {
			base_url: baseUrl,
			api_key: '',
			method: files?.length ? 'POST' : (req.method ?? 'GET'),
			path: req.path,
			body: req.body ?? null,
			timeout_ms: files?.length ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS,
			id
		};
		return files?.length
			? await invoke<unknown>('ace_upload', { call, files })
			: await invoke<unknown>('ace_json', { call });
	} catch (e) {
		throw fromRust(e, req.path.split('?')[0], signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}
