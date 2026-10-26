/**
 * `edit_image`'s `area`: changing part of a picture. Rust builds the canvas and
 * the mask (`image_mask_prepare`) and, after the edit, pastes it back through
 * the mask (`image_mask_finish`), so outside the mask the picture is the
 * original's on every backend.
 *
 * Rust can also grow the canvas (`MaskExtend`), but an edit model keeps an
 * empty border as it is; growing a picture needs masked inpainting, which
 * isn't wired up yet.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ImageInput } from '#lib/image/types.ts';
import type { MaskArea } from '#lib/ipc/gen/MaskArea.ts';
import type { PreparedEdit } from '#lib/ipc/gen/PreparedEdit.ts';

export interface MaskRequest {
	area?: MaskArea;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

function fractions<K extends string>(
	raw: unknown,
	keys: readonly K[],
	what: string
): Record<K, number> | string | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw !== 'object' || Array.isArray(raw)) return `${what} must be an object.`;
	const out = {} as Record<K, number>;
	for (const k of keys) {
		const v = (raw as Record<string, unknown>)[k];
		const n = v === undefined ? 0 : num(v);
		if (!Number.isFinite(n) || n < 0 || n > 1) {
			return `${what}.${k} must be a fraction from 0 to 1.`;
		}
		out[k] = n;
	}
	return out;
}

/** `area` from the tool's arguments; a string says what's wrong. */
export function maskRequest(args: Record<string, unknown>): MaskRequest | string {
	const area = fractions(args.area, ['x', 'y', 'width', 'height'] as const, 'area');
	if (typeof area === 'string') return area;
	if (area && (area.width === 0 || area.height === 0)) {
		return 'area needs a width and a height.';
	}
	return area ? { area } : {};
}

/** The canvas and mask for `source`, kept in the image cache. */
export async function prepareMasked(
	source: ImageInput,
	mask: MaskRequest,
	conversationId: string | null
): Promise<PreparedEdit> {
	return invoke<PreparedEdit>('image_mask_prepare', {
		source: 'hash' in source ? { hash: source.hash } : { bytes: source.bytes },
		area: mask.area ?? null,
		extend: null,
		conversationId
	});
}

/** `edited` pasted over the prepared canvas through its mask, as PNG bytes. */
export async function finishMasked(
	edited: Uint8Array,
	prepared: PreparedEdit
): Promise<Uint8Array> {
	const png = await invoke<ArrayBuffer>('image_mask_finish', edited, {
		headers: { 'x-canvas-hash': prepared.canvas, 'x-mask-hash': prepared.mask }
	});
	return new Uint8Array(png);
}
