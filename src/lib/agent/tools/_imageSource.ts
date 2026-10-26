/**
 * A picture an image tool works on: one the user attached to their message
 * ("attached", or "attached:2" for the second), one drawn earlier in the
 * conversation (its `haruspex-img://` URL), or a file in the working folder.
 * A cached picture goes to the server by hash (Rust reads it); the others'
 * bytes are read here. Each is measured, so the result keeps its shape.
 */
import { invoke } from '@tauri-apps/api/core';
import { errMessage } from '#lib/utils/error.ts';
import { dataUrlBytes } from '#lib/utils/base64.ts';
import { imageHashFromUrl } from '#lib/images/url.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';
import { assetIo } from '#lib/agent/tools/_assetIo.ts';
import type { ImageInput } from '#lib/image/types.ts';

export interface ImageSource {
	input: ImageInput;
	width: number;
	height: number;
}

/** A picture's size, from its bytes; null when the webview can't decode it. */
export type MeasureImage = (bytes: Uint8Array) => Promise<{ width: number; height: number } | null>;

export const measureImage: MeasureImage = async (bytes) => {
	try {
		const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return size;
	} catch {
		return null;
	}
};

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const ATTACHED = /^attached(?::(\d+))?$/i;

type Read = { input: ImageInput; bytes: Uint8Array } | string;

/** The user's `n`th attached picture. */
function readAttached(n: number, what: string, ctx: ToolContext): Read {
	const urls = ctx.userImages ?? [];
	if (urls.length === 0) return `${what}: the user hasn't attached a picture.`;
	const bytes = n >= 1 && n <= urls.length ? dataUrlBytes(urls[n - 1]) : null;
	if (!bytes) {
		return `${what}: there are ${urls.length} attached pictures; use attached:1 to attached:${urls.length}.`;
	}
	return { input: { name: `attached-${n}.png`, bytes: Array.from(bytes) }, bytes };
}

/** The input and bytes `ref` names, or why it can't be used. */
async function read(ref: string, what: string, ctx: ToolContext): Promise<Read> {
	const attached = ref.match(ATTACHED);
	if (attached) return readAttached(Number(attached[1] ?? 1), what, ctx);
	const hash = imageHashFromUrl(ref);
	if (hash) {
		try {
			const bytes = new Uint8Array(await invoke<ArrayBuffer>('image_read_bytes', { hash }));
			return { input: { name: 'image.png', hash }, bytes };
		} catch {
			return `${what} is no longer in the image cache.`;
		}
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) {
		return `${what} must be "attached", a haruspex-img:// URL from this conversation, or a file in the working folder.`;
	}
	if (!ctx.workingDir) {
		return `${what} is a path, but there is no working folder. In Chat, the user picks one with the folder button.`;
	}
	if (!IMAGE_FILE.test(ref)) return `${what} must be a .png, .jpg or .webp file.`;
	try {
		const raw = await assetIo(ctx).read(ref);
		return {
			input: { name: ref.split(/[\\/]/).pop() || 'image.png', bytes: raw },
			bytes: new Uint8Array(raw)
		};
	} catch (e) {
		return `Could not read ${ref}: ${errMessage(e)}`;
	}
}

/** The picture `raw` names, measured, or why it can't be used. */
export async function resolveImage(
	raw: string,
	what: string,
	ctx: ToolContext,
	measure: MeasureImage = measureImage
): Promise<ImageSource | string> {
	const ref = raw.trim();
	if (!ref) return `${what} is empty.`;
	const got = await read(ref, what, ctx);
	if (typeof got === 'string') return got;
	const size = await measure(got.bytes);
	if (!size) return `${what} could not be read as a picture.`;
	return { input: got.input, ...size };
}

/** About a megapixel, the size the edit models were trained at. */
const EDIT_AREA = 1024 * 1024;

/**
 * The size to edit a `width`×`height` picture at: its shape, at most about a
 * megapixel and never larger than it is, in multiples of 16.
 */
export function editSize(width: number, height: number): { width: number; height: number } {
	const scale = Math.min(1, Math.sqrt(EDIT_AREA / (width * height)));
	const fit = (n: number) => Math.max(256, Math.round((n * scale) / 16) * 16);
	return { width: fit(width), height: fit(height) };
}
