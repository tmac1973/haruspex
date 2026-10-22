/**
 * One asset, made the way the asset job makes one, without the job.
 *
 * The Shell assistant in code mode asks for "a 32 px coin sprite in assets/"
 * mid-session. That should come back like a job's asset — transparent,
 * cropped, sized, palette-reduced, checked — not as a raw 1024² picture. This
 * runs the job's per-entry path on a spec of one: the same request builders,
 * the same normalisation and checks. It leaves out what only makes sense for
 * a set: the style anchor and sheets of several subjects.
 */
import type { AssetEntry, AssetKind, AssetSpec, NormalizeProfile } from '#lib/assets/spec/types.ts';
import {
	checkImage,
	defaultProfile,
	effectiveProfile,
	normalizeImage
} from '#lib/assets/normalize.ts';
import { buildEntryRequest } from '#lib/agent/jobs/types/asset-generation/request.ts';
import { sheetRequest } from '#lib/agent/jobs/types/asset-generation/sheets.ts';
import { FALLBACK_STYLE } from '#lib/agent/jobs/types/asset-generation/derive.ts';
import { generateForTool } from '#lib/image/forTool.ts';
import { resolveImageBackend } from '#lib/image/backend.ts';
import type { ImageProgress } from '#lib/image/types.ts';

/** What `makeSingleAsset` draws. Textures are drawn by code (`assets/texture.ts`). */
export type SingleKind = Exclude<AssetKind, 'texture'> | 'image';

export interface SingleAssetInput {
	kind: SingleKind;
	prompt: string;
	/** Target edge in px. Defaults per kind. */
	size?: number;
	/** One style line; the job's fallback style when absent. */
	style?: string;
	/** Colours to draw in (0xRRGGBBAA), from an existing asset, to match a set. */
	palette?: number[];
	/** A plain picture that tiles edge to edge: a painted material. Image only. */
	seamless?: boolean;
}

export interface SingleAsset {
	bytes: Uint8Array;
	width: number;
	height: number;
	checks: { passed: boolean; failed: string[] };
	notes: string[];
	seed: number;
	model: string;
}

/** The size each kind is made at when none is asked for. */
export const DEFAULT_SIZE: Record<SingleKind, number> = {
	sprite: 64,
	icon: 32,
	image: 1024
};

/** The largest edge a request is generated at, as the job clamps it. */
const MAX_EDGE = 1024;

export async function makeSingleAsset(
	input: SingleAssetInput,
	opts: { signal?: AbortSignal; onProgress?: (p: ImageProgress) => void } = {}
): Promise<SingleAsset> {
	const size = input.size ?? DEFAULT_SIZE[input.kind];

	if (input.kind === 'image') return plainPicture(input.prompt, size, input.seamless, opts);

	const caps = await resolveImageBackend().capabilities();
	const kind = input.kind;
	const profile = await profileFor(kind, size, input.palette, caps.transparency);

	const entry: AssetEntry = { id: 'asset', kind, prompt: input.prompt, out: 'asset.png' };
	const spec: AssetSpec = {
		version: 1,
		style: { prompt: input.style?.trim() || FALLBACK_STYLE },
		anchor: { image: '', recipe: '' },
		normalize: profile,
		entries: [entry]
	} as AssetSpec;

	// On a backend with alpha, drawn the way the job draws them: as a sheet of
	// one, asked for transparency. Otherwise the single-entry request, with
	// its keyed background.
	const request = caps.transparency
		? sheetRequest([entry], spec)
		: buildEntryRequest(entry, spec, profile, caps, { maxEdge: MAX_EDGE }).request;

	let best: SingleAsset | null = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const img = await generateForTool(
			{ ...request, seed: attempt === 1 ? request.seed : null },
			opts
		);
		const result = await finish(img, kind, profile, size);
		if (result.checks.passed) return result;
		// Keep the one that failed fewer checks; never throw a usable image away.
		if (!best || result.checks.failed.length < best.checks.failed.length) best = result;
	}
	return best!;
}

/** Normalise and check one drawing. */
async function finish(
	img: Awaited<ReturnType<typeof generateForTool>>,
	kind: AssetKind,
	profile: NormalizeProfile,
	size: number
): Promise<SingleAsset> {
	const normalized = await normalizeImage(img.bytes, profile, kind);
	const report = await checkImage(normalized.stats, profile, kind);
	const bytes = new Uint8Array(normalized.bytes);
	return {
		...img,
		bytes,
		...(pngSize(bytes) ?? { width: size, height: size }),
		checks: { passed: report.passed, failed: report.failed }
	};
}

/**
 * A plain picture: drawn, not normalised. `seamless` asks the backend to make
 * it tile; one that can't says so in the notes.
 */
async function plainPicture(
	prompt: string,
	size: number,
	seamless: boolean | undefined,
	opts: { signal?: AbortSignal; onProgress?: (p: ImageProgress) => void }
): Promise<SingleAsset> {
	// A plain picture is not downscaled, so it is drawn at a size the
	// models can draw: they make mush below 512.
	const edge = Math.round(Math.min(Math.max(size, 512), MAX_EDGE) / 64) * 64;
	const img = await generateForTool(
		{ prompt, width: edge, height: edge, seed: null, seamless: seamless === true },
		opts
	);
	return { ...img, checks: { passed: true, failed: [] } };
}

/**
 * The job's profile for one kind at one size. The job's palette rule: on a
 * backend with alpha each image takes its own palette; a palette asked for (to
 * match a set) is imposed either way.
 */
async function profileFor(
	kind: AssetKind,
	size: number,
	palette: number[] | undefined,
	transparency: boolean
): Promise<NormalizeProfile> {
	const base: NormalizeProfile = { ...(await defaultProfile()), target_size: size };
	const withPalette = palette?.length
		? { ...base, palette }
		: transparency
			? { ...base, palette: [] }
			: base;
	return effectiveProfile(withPalette, kind);
}

/** A PNG's pixel size from its header, or null if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: v.getUint32(16), height: v.getUint32(20) };
}
