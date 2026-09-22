/**
 * The resolution a checkpoint was trained at, and the upscale that follows.
 *
 * Generation happens at `target_size * upscale`, so `upscale` is only
 * meaningful relative to the model: SD1.5 degrades above 512 and SDXL
 * produces artefacts below 1024. A 32px target therefore wants 16 on one and
 * 32 on the other, and getting it wrong is not subtle — an SDXL sheet
 * generated at 512 comes out as mush.
 *
 * This is the field the catalogue carries `native_edge` for. Deriving the
 * upscale from it is what stops a user discovering the mismatch by looking at
 * bad sprites, which is exactly how it was discovered.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '$lib/stores/settings';
import { MAX_GENERATION_EDGE } from './config';

/** What a catalogue entry tells us about the model it names. */
interface CatalogueEntry {
	id: string;
	filename: string;
	native_edge: number;
}

/**
 * The native edge of the checkpoint this run will use, or null.
 *
 * Null rather than a guess. The checkpoint may be any file the user has, and
 * inferring "xl" from a filename would be wrong exactly when it matters — a
 * fine-tune named after its style rather than its base. An unrecognised model
 * keeps the profile's own upscale and the report says the assumption was
 * made, which is honest in a way that a heuristic is not.
 */
export async function nativeEdgeFor(specModel: string | undefined): Promise<number | null> {
	const s = getSettings();
	// The spec pins the model for the whole set; the backend's configured
	// default is what it falls back to. Same precedence the request uses.
	const name = (specModel ?? '').trim() || (s.imageComfyCheckpoint ?? '').trim();
	const id = (s.imageLocalModelId ?? '').trim();

	try {
		const catalogue = await invoke<CatalogueEntry[]>('image_models');
		const match = catalogue.find(
			(m) =>
				(id && m.id === id) ||
				(name && (m.id === name || m.filename === name || name.endsWith(m.filename)))
		);
		return match?.native_edge ?? null;
	} catch {
		return null;
	}
}

/**
 * The upscale that puts generation at the model's native edge.
 *
 * Clamped at both ends: below 1 there is no generation at all, and above the
 * pipeline's ceiling is an allocation no consumer GPU survives. A target size
 * larger than the native edge yields 1 rather than a fraction — generating
 * BELOW native is the artefact case, so the floor is the right failure.
 */
export function upscaleForEdge(targetSize: number, nativeEdge: number): number {
	const target = Math.max(1, targetSize);
	const edge = Math.min(Math.max(1, nativeEdge), MAX_GENERATION_EDGE);
	return Math.max(1, Math.round(edge / target));
}
