/**
 * Calls to a Lemonade server, made from Rust (`lemonade_json`) for the reasons
 * the ComfyUI client gives: no `Origin` for the server to refuse, and the API
 * key read from the secret store rather than handed to the webview.
 */

import { BACKEND_TIMEOUT_MS, invokeBackend, type Backend } from '#lib/utils/backendCall.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { errorMessage } from '#lib/image/lemonade/adapter.ts';

export interface LemonadeConfig {
	baseUrl: string;
	/** Inline only where no secret store works; Rust falls back to `lemonade:key`. */
	apiKey: string;
}

/** The server Settings → Image is working with; see {@link useLemonadeServer}. */
let working: LemonadeConfig | null = null;

/**
 * Point Settings' Lemonade panels (install, remove, the model list) at the
 * open image model's server. A generation is sent to its own entry's.
 */
export function useLemonadeServer(cfg: LemonadeConfig): void {
	working = { baseUrl: cfg.baseUrl.trim(), apiKey: cfg.apiKey };
}

/** The Lemonade server Settings is working with, or the old field's before one was opened. */
export function lemonadeConfig(): LemonadeConfig {
	if (working) return working;
	const s = getSettings();
	return { baseUrl: s.imageLemonadeBaseUrl.trim(), apiKey: s.imageLemonadeApiKey };
}

const lemonade: Backend<ImageBackendError> = {
	prefix: 'lemonade',
	server: 'Lemonade',
	cancelled: () => new ImageBackendError('cancelled', 'Generation cancelled.'),
	error: (kind, message) => new ImageBackendError(kind, message),
	rejected: (status, body, path) =>
		new ImageBackendError(
			'rejected',
			`Lemonade refused ${path}: ${errorMessage(body) ?? `status ${status}`}`,
			{ status, body: body.slice(0, 200) }
		)
};

export function lemonadeJson(
	cfg: LemonadeConfig,
	call: { method?: 'GET' | 'POST'; path: string; body?: unknown; timeoutMs?: number },
	signal?: AbortSignal
): Promise<unknown> {
	return invokeBackend(
		lemonade,
		'lemonade_json',
		call.path,
		(id) => ({
			call: {
				base_url: cfg.baseUrl,
				api_key: cfg.apiKey,
				method: call.method ?? 'GET',
				path: call.path,
				body: call.body ?? null,
				timeout_ms: call.timeoutMs ?? BACKEND_TIMEOUT_MS,
				id
			}
		}),
		signal
	);
}

/** A multipart POST (`lemonade_upload`): each of `fields` a text part, each file its own. */
export function lemonadeUpload(
	cfg: LemonadeConfig,
	call: { path: string; fields: Record<string, string>; timeoutMs: number },
	files: UploadFile[],
	signal?: AbortSignal
): Promise<unknown> {
	return invokeBackend(
		lemonade,
		'lemonade_upload',
		call.path,
		(id) => ({
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
		}),
		signal
	);
}
