/**
 * Calls to a Lemonade server, made from Rust (`lemonade_json`) for the reasons
 * the ComfyUI client gives: no `Origin` for the server to refuse, and the API
 * key read from the secret store rather than handed to the webview.
 */

import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import type { ComfyError } from '#lib/ipc/gen/ComfyError.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { errorMessage } from '#lib/image/lemonade/adapter.ts';

export interface LemonadeConfig {
	baseUrl: string;
	/** Inline only where no secret store works; Rust falls back to `lemonade:key`. */
	apiKey: string;
}

export function lemonadeConfig(): LemonadeConfig {
	const s = getSettings();
	return { baseUrl: s.imageLemonadeBaseUrl.trim(), apiKey: s.imageLemonadeApiKey };
}

/** Enough for anything but a generation, which passes its own. */
export const DEFAULT_TIMEOUT_MS = 30_000;

let nextId = 0;

function fromRust(e: unknown, path: string, signal?: AbortSignal): ImageBackendError {
	const err = (e !== null && typeof e === 'object' && 'kind' in e ? e : null) as ComfyError | null;
	switch (err?.kind) {
		case 'cancelled':
			return new ImageBackendError('cancelled', 'Generation cancelled.');
		case 'timeout':
		case 'unreachable':
			return new ImageBackendError(err.kind, err.message);
		case 'rejected': {
			const why = errorMessage(err.body) ?? `status ${err.status}`;
			return new ImageBackendError('rejected', `Lemonade refused ${path}: ${why}`, {
				status: err.status,
				body: err.body.slice(0, 200)
			});
		}
		default:
			if (signal?.aborted) return new ImageBackendError('cancelled', 'Generation cancelled.');
			return new ImageBackendError(
				'unreachable',
				`The request to Lemonade failed — ${errMessage(e)}`
			);
	}
}

export async function lemonadeJson(
	cfg: LemonadeConfig,
	call: { method?: 'GET' | 'POST'; path: string; body?: unknown; timeoutMs?: number },
	signal?: AbortSignal
): Promise<unknown> {
	if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
	const id = `lemonade-${++nextId}`;
	// The cancel table is shared with ComfyUI's calls.
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<unknown>('lemonade_json', {
			call: {
				base_url: cfg.baseUrl,
				api_key: cfg.apiKey,
				method: call.method ?? 'GET',
				path: call.path,
				body: call.body ?? null,
				timeout_ms: call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				id
			}
		});
	} catch (e) {
		throw fromRust(e, call.path, signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

/** A multipart POST (`lemonade_upload`): each of `fields` a text part, each file its own. */
export async function lemonadeUpload(
	cfg: LemonadeConfig,
	call: { path: string; fields: Record<string, string>; timeoutMs: number },
	files: UploadFile[],
	signal?: AbortSignal
): Promise<unknown> {
	if (signal?.aborted) throw new ImageBackendError('cancelled', 'Generation cancelled.');
	const id = `lemonade-${++nextId}`;
	const onAbort = () => void invoke('comfy_cancel', { id }).catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		return await invoke<unknown>('lemonade_upload', {
			call: {
				base_url: cfg.baseUrl,
				api_key: cfg.apiKey,
				method: 'POST',
				path: call.path,
				body: call.fields,
				timeout_ms: call.timeoutMs,
				id
			},
			files
		});
	} catch (e) {
		throw fromRust(e, call.path, signal);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}
