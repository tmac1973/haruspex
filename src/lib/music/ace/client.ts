/**
 * Calls to an ace-server, made from Rust (`ace_json`): it answers no CORS
 * preflight, so the webview could not call it directly. Errors come back as
 * {@link MusicBackendError}s.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import type { ComfyError } from '#lib/ipc/gen/ComfyError.ts';
import { MusicBackendError } from '#lib/music/types.ts';
import { errorOf } from '#lib/music/ace/adapter.ts';

const TIMEOUT_MS = 30_000;

let nextId = 0;

function fromRust(e: unknown, path: string, signal?: AbortSignal): MusicBackendError {
	const err = (e !== null && typeof e === 'object' && 'kind' in e ? e : null) as ComfyError | null;
	switch (err?.kind) {
		case 'cancelled':
			return new MusicBackendError('cancelled', 'Cancelled.');
		case 'timeout':
		case 'unreachable':
			return new MusicBackendError(err.kind, err.message);
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

export async function aceJson(
	baseUrl: string,
	req: { method?: 'GET' | 'POST'; path: string; body?: unknown },
	signal?: AbortSignal
): Promise<unknown> {
	if (signal?.aborted) throw new MusicBackendError('cancelled', 'Cancelled.');
	const id = `ace-${++nextId}`;
	// The cancel table is shared with the image servers' calls.
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<unknown>('ace_json', {
			call: {
				base_url: baseUrl,
				api_key: '',
				method: req.method ?? 'GET',
				path: req.path,
				body: req.body ?? null,
				timeout_ms: TIMEOUT_MS,
				id
			}
		});
	} catch (e) {
		throw fromRust(e, req.path.split('?')[0], signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}
