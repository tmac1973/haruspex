/**
 * `edit_image`'s `area` and `extend`: changing part of a picture, or growing
 * it past its edges. Rust builds the canvas and the mask (`image_mask_prepare`)
 * and, after the edit, pastes it back through the mask (`image_mask_finish`),
 * so outside the mask the picture is the original's on every backend.
 *
 * An area is an edit; an extend is an inpaint (`ImageRequest.inpaint`), since
 * an edit model keeps an empty border as it is.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ImageInput } from '#lib/image/types.ts';
import type { MaskArea } from '#lib/ipc/gen/MaskArea.ts';
import type { MaskExtend } from '#lib/ipc/gen/MaskExtend.ts';
import type { PreparedEdit } from '#lib/ipc/gen/PreparedEdit.ts';

export interface MaskRequest {
	area?: MaskArea;
	extend?: MaskExtend;
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

/** `area` and `extend` from the tool's arguments; a string says what's wrong. */
export function maskRequest(args: Record<string, unknown>): MaskRequest | string {
	const area = fractions(args.area, ['x', 'y', 'width', 'height'] as const, 'area');
	if (typeof area === 'string') return area;
	if (area && (area.width === 0 || area.height === 0)) {
		return 'area needs a width and a height.';
	}
	const extend = fractions(args.extend, ['left', 'right', 'top', 'bottom'] as const, 'extend');
	if (typeof extend === 'string') return extend;
	if (extend && Object.values(extend).every((v) => v === 0)) {
		return 'extend needs at least one side greater than 0.';
	}
	return { ...(area ? { area } : {}), ...(extend ? { extend } : {}) };
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
		extend: mask.extend ?? null,
		conversationId
	});
}

/**
 * Below this mean difference (0–255) where the mask allowed change, the
 * backend left that part nearly as it was. Measured: an edit model handed a
 * blurred border scored ~3–5; real extends ~35, a new sky ~90.
 */
export const UNCHANGED = 8;

/** Said when the masked part came back nearly unchanged. */
export const UNCHANGED_NOTE =
	'The part that was to change came back nearly as it was, so the backend may not have made ' +
	'the change. Check the picture, and if so tell the user it didn’t work rather than ' +
	'describing what was asked for.';

/** How much `edited` changed where the mask allowed, 0–255; null when it couldn't be measured. */
export async function maskedChange(
	edited: Uint8Array,
	prepared: PreparedEdit
): Promise<number | null> {
	try {
		return await invoke<number>('image_mask_change', edited, {
			headers: { 'x-canvas-hash': prepared.canvas, 'x-mask-hash': prepared.mask }
		});
	} catch {
		return null;
	}
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
