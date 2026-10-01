/**
 * Turning one spec entry into one `ImageRequest`.
 *
 * Pure, and separate from the loop on purpose: what a request says is the
 * thing that decides whether an asset is usable, and it is far easier to hold
 * the prompt rules still when they are not tangled up with concurrency,
 * retries and file writes.
 */

import { joinNegativePrompts } from '$lib/assets/spec/types';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import type { ImageBackendCapabilities, ImageRequest, LoraRef } from '$lib/image/types';
import { colourWord } from './anchor';
import { fitStyle } from './promptBudget';

/**
 * The isolation scaffold, and it is a precondition of background removal
 * rather than a nicety.
 *
 * The colour is named in WORDS for the same reason the anchor's is: a prompt
 * saying "#ff00ff" produces no magenta at all, so there is no background to
 * remove and every sprite comes back fully opaque. The first real run of this
 * pipeline failed all four assets that way.
 *
 * Measured against SD1.5: three prompts of the form "a sword, game item icon,
 * centered, on a flat solid magenta background" produced full-frame
 * compositions whose borders were 38%, 46% and 56% one colour. There was no
 * background to remove, so every sprite came out fully opaque and failed its
 * alpha check. The same three subjects under this scaffold reached 88% and 95%
 * border coherence and keyed cleanly.
 *
 * Sprites and icons only. A texture is meant to fill its frame, and telling it
 * to leave empty space around a centred subject would ruin it.
 */
export function isolationScaffold(subject: string, background: string): string {
	// ONCE. Measured on SDXL: naming the key colour twice tinted 30% of the
	// subject's own pixels that colour and once tinted 12%. Said three times,
	// as this did, the subject comes out wearing the backdrop — and since the
	// palette is extracted from the art, the whole set goes that colour.
	return (
		`a single ${subject}, one object only, small in frame, centred, ` +
		`isolated on a plain flat ${background} background, ` +
		`lots of empty space around it, product shot, simple`
	);
}

export const ISOLATION_NEGATIVE =
	'background scenery, pattern, multiple objects, collage, tiled, busy, border, ' +
	'frame, texture background, gradient, landscape, cropped, close-up';

/** Sprites and icons are one object on a background; a texture is the background. */
export function wantsIsolation(kind: AssetEntry['kind']): boolean {
	return kind === 'sprite' || kind === 'icon';
}

/**
 * The prompt for one entry: scaffold, then the style.
 *
 * The style has the last word because it is the thing the whole set shares —
 * a scaffold that overrode it would make every asset isolated and none of them
 * the same game.
 */
export function entryPrompt(entry: AssetEntry, spec: AssetSpec, profile: NormalizeProfile): string {
	const background = colourWord(profile.background.color);
	const subject = wantsIsolation(entry.kind)
		? isolationScaffold(entry.prompt, background)
		: entry.prompt;
	// Same window, same reason as the anchor: the isolation scaffold plus a
	// subject plus a richly written style runs well past CLIP's 77 tokens, and
	// what falls off the end is whatever came last.
	const style = fitStyle(spec.style.prompt).text;
	return [subject, style].filter((s) => s.trim().length > 0).join(', ');
}

export function entryNegativePrompt(entry: AssetEntry, spec: AssetSpec): string {
	const isolation = wantsIsolation(entry.kind) ? ISOLATION_NEGATIVE : '';
	return joinNegativePrompts(
		joinNegativePrompts(entry.negativePrompt, isolation),
		spec.style.negativePrompt
	);
}

/**
 * A texture as a DiT model draws it best, measured on Ming-Image (phase 23).
 *
 * Without a view the model draws the surface as a scene: a road receding to a
 * horizon, a warehouse floor with the warehouse around it. "Seamlessly tiling"
 * draws a grid of tiles, so it is taken out of the subject; the seam is the
 * backend's job, not the prompt's. Ground is seen from directly above — "straight
 * on" brought the road's perspective back at one seed of two — and a wall straight
 * on, which drew clean brick where "from above" has no meaning.
 *
 * Not used on SD checkpoints: CLIP reads 77 tokens, and this costs about 35.
 */
export function textureScaffold(subject: string, style: string): string {
	const surface = subject
		.replace(/^\s*seamless(ly)?(\s+tiling)?[\s,]+/i, '')
		.replace(/[.\s]+$/, '');
	const view = /\b(wall|facade|fa\u00e7ade|front)\b/i.test(surface)
		? 'straight on'
		: 'from directly above';
	const lead = style.trim().replace(/[.\s]+$/, '');
	return (
		`${lead ? `${lead}. ` : ''}A flat game texture of ${surface}, seen ${view}. ` +
		'One continuous surface filling the whole frame edge to edge: ' +
		'no perspective, no horizon, no grid lines, no border, no frame.'
	);
}

/**
 * Above this seam ratio a tiled texture has a seam you can see.
 *
 * Measured on fifty generated textures at 64 px (phase 23): every one that
 * looked right scored at most 1.8, every one with a visible seam 4.3 or more.
 * Set only on a request that asked the backend to tile; see `CheckThresholds`.
 */
export const TEXTURE_SEAM_MAX = 3;

/** The profile a texture is checked against: with the seam check if it was made to tile. */
export function checkProfile(profile: NormalizeProfile, request: ImageRequest): NormalizeProfile {
	return request.seamless
		? { ...profile, checks: { ...profile.checks, seam_max: TEXTURE_SEAM_MAX } }
		: profile;
}

/**
 * The edge to generate at, from the effective profile.
 *
 * An entry may override `target_size`; the upscale and the clamp still apply,
 * so one oversized entry cannot ask for an allocation the rest of the run
 * survived without.
 */
export function entryEdge(entry: AssetEntry, profile: NormalizeProfile, maxEdge: number): number {
	const target = entry.size ?? profile.target_size;
	return Math.min(target * profile.upscale, maxEdge);
}

/** A coherence layer this entry had to do without, in the words the report prints. */
export type Degradation = string;

export interface BuiltRequest {
	request: ImageRequest;
	degraded: Degradation[];
}

/**
 * Build the request, degrading against what the backend actually offers.
 *
 * Degradation is recorded, never silent. A weaker backend should still produce
 * a usable set — but the report has to say which layers it did without, or a
 * user comparing two runs has no way to know why one looks worse.
 */
export function buildEntryRequest(
	entry: AssetEntry,
	spec: AssetSpec,
	profile: NormalizeProfile,
	caps: ImageBackendCapabilities,
	opts: { maxEdge: number; seed?: number | null }
): BuiltRequest {
	const degraded: Degradation[] = [];
	const edge = entryEdge(entry, profile, opts.maxEdge);

	const seamless = entry.seamless ?? entry.kind === 'texture';
	if (seamless && !caps.seamlessTiling) {
		// Generated anyway: a visible seam beats a missing texture, and the
		// report says which it is.
		degraded.push('not seamless');
	}

	const wanted: LoraRef[] = spec.style.loras ?? [];
	let loras: LoraRef[] = wanted;
	if (wanted.length > 0) {
		if (!caps.loras || caps.maxLoras <= 0) {
			loras = [];
			degraded.push(`no LoRA support — ${wanted.length} dropped`);
		} else if (wanted.length > caps.maxLoras) {
			loras = wanted.slice(0, caps.maxLoras);
			degraded.push(`${wanted.length - caps.maxLoras} of ${wanted.length} LoRAs dropped`);
		}
	}

	return {
		request: {
			// A backend with alpha is a DiT model, which reads a whole sentence.
			prompt:
				entry.kind === 'texture' && caps.transparency
					? textureScaffold(entry.prompt, spec.style.prompt)
					: entryPrompt(entry, spec, profile),
			negativePrompt: entryNegativePrompt(entry, spec),
			width: edge,
			height: edge,
			seed: opts.seed ?? entry.seed ?? null,
			model: spec.style.model,
			loras: loras.length > 0 ? loras : undefined,
			seamless: seamless && caps.seamlessTiling ? true : undefined
		},
		degraded
	};
}
