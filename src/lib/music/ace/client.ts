/**
 * Calls to an ace-server, made from Rust (`ace_json`): it answers no CORS
 * preflight, so the webview could not call it directly. Errors come back as
 * {@link MusicBackendError}s.
 */

import {
	BACKEND_TIMEOUT_MS,
	BACKEND_UPLOAD_TIMEOUT_MS,
	invokeBackend,
	type Backend
} from '#lib/utils/backendCall.ts';
import { MusicBackendError } from '#lib/music/types.ts';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { errorOf } from '#lib/music/ace/adapter.ts';

const ace: Backend<MusicBackendError> = {
	prefix: 'ace',
	server: 'ace-server',
	cancelled: () => new MusicBackendError('cancelled', 'Cancelled.'),
	error: (kind, message) => new MusicBackendError(kind, message),
	rejected: (status, body, path) =>
		new MusicBackendError(
			'rejected',
			`ace-server refused ${path}: ${errorOf(body) ?? `status ${status}`}`,
			{ status }
		)
};

/**
 * A call to ace-server. With `files` it is a multipart POST (`ace_upload`):
 * the body in a `request` part and each song in its own.
 */
export function aceJson(
	baseUrl: string,
	req: { method?: 'GET' | 'POST'; path: string; body?: unknown },
	signal?: AbortSignal,
	files?: UploadFile[]
): Promise<unknown> {
	const upload = !!files?.length;
	return invokeBackend(
		ace,
		upload ? 'ace_upload' : 'ace_json',
		req.path.split('?')[0],
		(id) => ({
			call: {
				base_url: baseUrl,
				api_key: '',
				method: upload ? 'POST' : (req.method ?? 'GET'),
				path: req.path,
				body: req.body ?? null,
				timeout_ms: upload ? BACKEND_UPLOAD_TIMEOUT_MS : BACKEND_TIMEOUT_MS,
				id
			},
			...(upload ? { files } : {})
		}),
		signal
	);
}
