/**
 * The OpenAI images API shapes that Lemonade's sd-cpp recipe and
 * llama-toolchest both speak: the `data[].b64_json` answer, the
 * `/images/edits` form's picture parts, and the upscale route. Each backend's own adapter owns the
 * rest of its request.
 */

import { invoke } from '@tauri-apps/api/core';
import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { fromBase64, toBase64 } from '#lib/image/local/adapter.ts';
import { base64Of } from '#lib/image/sdcpp.ts';
import { errMessage } from '#lib/utils/error.ts';
import { ImageBackendError, type ImageEdit, type ImageInput } from '#lib/image/types.ts';

/** The images in an OpenAI-style answer, in order. */
export function imagesFrom(payload: unknown): Uint8Array[] {
	const data = (payload as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	return data
		.map((d) => (d as { b64_json?: unknown })?.b64_json)
		.filter((b): b is string => typeof b === 'string')
		.map(fromBase64);
}

/**
 * An upscale on an OpenAI-shaped route: `post` sends `{model, image}` (the
 * picture as base64), and the answer's first `b64_json` under `answerKey` is
 * the result — `data` on Lemonade, `images` on llama-toolchest. `server` names
 * it when nothing comes back. A cached picture goes as RGB: sd.cpp's upscaler
 * refuses alpha ("upscale requires RGB", #1352), and the caller puts it back.
 */
export async function upscaleVia(
	post: (body: { model: string; image: string }) => Promise<unknown>,
	model: string,
	input: ImageInput,
	answerKey: 'data' | 'images',
	server: string
): Promise<Uint8Array> {
	const payload = await post({ model, image: await rgbBase64Of(input) });
	const list = (payload as Record<string, unknown> | null)?.[answerKey];
	const b64 = Array.isArray(list) ? (list[0] as { b64_json?: unknown })?.b64_json : undefined;
	if (typeof b64 !== 'string') {
		throw new ImageBackendError('rejected', `${server} returned no upscaled picture.`);
	}
	return fromBase64(b64);
}

/** `input` as base64, flattened to RGB when it is in the image cache. */
async function rgbBase64Of(input: ImageInput): Promise<string> {
	if (!('hash' in input)) return base64Of(input);
	let bytes: ArrayBuffer;
	try {
		bytes = await invoke<ArrayBuffer>('image_read_rgb', { hash: input.hash });
	} catch (e) {
		const detail = errMessage(e);
		throw new ImageBackendError(
			'rejected',
			detail === 'Image not found' ? 'That picture is no longer in the image cache.' : detail
		);
	}
	return toBase64(new Uint8Array(bytes));
}

/** A picture as a form part: its bytes, or its image-cache hash for Rust to read. */
function upload(field: string, input: ImageInput): UploadFile {
	return {
		field,
		filename: input.name,
		hash: 'hash' in input ? input.hash : null,
		cache: 'hash' in input ? 'image' : null,
		bytes: 'bytes' in input ? input.bytes : null
	};
}

/**
 * An edit's pictures as the form's `image[]` parts, then its `mask`, white
 * where it may change, as OpenAI's edits route names it.
 */
export function editUploads(edit: ImageEdit): UploadFile[] {
	return [
		...edit.images.map((i) => upload('image[]', i)),
		...(edit.mask ? [upload('mask', edit.mask)] : [])
	];
}
