/**
 * The OpenAI images API shapes that Lemonade's sd-cpp recipe and
 * llama-toolchest both speak: the `data[].b64_json` answer, and the
 * `/images/edits` form's picture parts. Each backend's own adapter owns the
 * rest of its request.
 */

import type { UploadFile } from '#lib/ipc/gen/UploadFile.ts';
import { fromBase64 } from '#lib/image/local/adapter.ts';
import type { ImageEdit, ImageInput } from '#lib/image/types.ts';

/** The images in an OpenAI-style answer, in order. */
export function imagesFrom(payload: unknown): Uint8Array[] {
	const data = (payload as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	return data
		.map((d) => (d as { b64_json?: unknown })?.b64_json)
		.filter((b): b is string => typeof b === 'string')
		.map(fromBase64);
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
