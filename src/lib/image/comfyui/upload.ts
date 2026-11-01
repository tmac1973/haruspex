/**
 * `POST /upload/image`: a picture into a ComfyUI server's input folder, for an
 * edit's `LoadImage`. Apart from `client.ts`, whose calls carry JSON, because
 * this one is a multipart form.
 *
 * In the app it goes through Rust (`comfy_upload`), which reads a cached
 * picture by hash so it never crosses the bridge; outside the app (tests,
 * Node) through `fetch`, which can only send bytes it was given.
 */

import { isTauri } from '@tauri-apps/api/core';
import { ImageBackendError, type ImageInput } from '#lib/image/types.ts';
import { invokeBackend } from '#lib/utils/backendCall.ts';
import {
	HTTP_TIMEOUT_MS,
	authHeaders,
	comfyBackend,
	rejectionMessage,
	trimUrl,
	type ClientConfig
} from '#lib/image/comfyui/client.ts';

const PATH = '/upload/image';

function viaRust(
	cfg: ClientConfig,
	input: ImageInput,
	name: string,
	signal?: AbortSignal
): Promise<unknown> {
	return invokeBackend<unknown, ImageBackendError>(
		comfyBackend,
		'comfy_upload',
		PATH,
		(id) => ({
			call: {
				base_url: cfg.baseUrl,
				api_key: cfg.apiKey,
				method: 'POST',
				path: PATH,
				body: { overwrite: 'true' },
				timeout_ms: HTTP_TIMEOUT_MS,
				id
			},
			files: [
				{
					field: 'image',
					filename: name,
					hash: 'hash' in input ? input.hash : null,
					cache: 'hash' in input ? 'image' : null,
					bytes: 'bytes' in input ? input.bytes : null
				}
			]
		}),
		signal
	);
}

async function viaFetch(
	cfg: ClientConfig,
	input: ImageInput,
	name: string,
	signal?: AbortSignal
): Promise<unknown> {
	if (!('bytes' in input)) {
		throw new ImageBackendError('rejected', 'A cached picture can only be uploaded from the app.');
	}
	const form = new FormData();
	form.append('image', new Blob([new Uint8Array(input.bytes)], { type: 'image/png' }), name);
	form.append('overwrite', 'true');
	const res = await fetch(`${trimUrl(cfg.baseUrl)}${PATH}`, {
		method: 'POST',
		headers: authHeaders(cfg),
		body: form,
		signal
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new ImageBackendError('rejected', rejectionMessage(PATH, body), { status: res.status });
	}
	return res.json();
}

/**
 * Upload `input` as `name` and return what `LoadImage` takes. `overwrite`, so
 * a name the caller made unique is kept as it is rather than numbered.
 */
export async function uploadImage(
	cfg: ClientConfig,
	input: ImageInput,
	name: string,
	signal?: AbortSignal
): Promise<string> {
	const answer = isTauri()
		? await viaRust(cfg, input, name, signal)
		: await viaFetch(cfg, input, name, signal);
	const a = (answer ?? {}) as { name?: unknown; subfolder?: unknown };
	if (typeof a.name !== 'string' || !a.name) {
		throw new ImageBackendError(
			'rejected',
			'The image backend did not say where it put the picture.'
		);
	}
	return typeof a.subfolder === 'string' && a.subfolder ? `${a.subfolder}/${a.name}` : a.name;
}

/** An inpaint's canvas and mask, each under a name of its own. */
export async function uploadInpaint(
	cfg: ClientConfig,
	inpaint: { image: ImageInput; mask: ImageInput },
	signal?: AbortSignal
): Promise<{ image: string; mask: string }> {
	const id = crypto.randomUUID();
	return {
		image: await uploadImage(cfg, inpaint.image, `haruspex-inpaint-${id}.png`, signal),
		mask: await uploadImage(cfg, inpaint.mask, `haruspex-mask-${id}.png`, signal)
	};
}
