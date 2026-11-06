/**
 * The OpenAI images API shapes that Lemonade's sd-cpp recipe and
 * llama-toolchest both speak: the `data[].b64_json` answer, the
 * `/images/edits` form's picture parts, and the upscale route. Each backend's own adapter owns the
 * rest of its request.
 */

import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { fromBase64 } from '#lib/image/local/adapter.ts';
import { base64Of } from '#lib/image/sdcpp.ts';
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
 * it when nothing comes back.
 */
export async function upscaleVia(
	post: (body: { model: string; image: string }) => Promise<unknown>,
	model: string,
	input: ImageInput,
	answerKey: 'data' | 'images',
	server: string
): Promise<Uint8Array> {
	const payload = await post({ model, image: await base64Of(input) });
	const list = (payload as Record<string, unknown> | null)?.[answerKey];
	const b64 = Array.isArray(list) ? (list[0] as { b64_json?: unknown })?.b64_json : undefined;
	if (typeof b64 !== 'string') {
		throw new ImageBackendError('rejected', `${server} returned no upscaled picture.`);
	}
	return fromBase64(b64);
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
