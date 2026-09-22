/**
 * The style anchor: one reference sheet every asset is conditioned on, and the
 * exact recipe that produced it, both committed into the project.
 *
 * Committing it is the whole point. The style becomes a versioned artifact
 * rather than something reconstructed from a recipe against model weights and
 * node versions that will have moved — so adding ten sprites next month
 * matches the hundred already shipped, because it is literally the same
 * reference image.
 */

import { invoke } from '@tauri-apps/api/core';
import { askUserQuestion } from '$lib/stores/userQuestion.svelte';
import { registerLocalImage } from '$lib/images/resolve.svelte';
import { extractPalette } from '$lib/assets/normalize';
import type { AssetSpec, AnchorRecipe } from '$lib/assets/spec/types';
import { resolveImageBackend } from '$lib/image';
import type { ImageResult } from '$lib/image/types';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';
import type { AnchorOutcome } from './types';

/** `0xRRGGBBAA` as `#RRGGBB`. For the recipe and the UI, never for a prompt. */
export function hexColor(packed: number): string {
	const r = (packed >>> 24) & 0xff;
	const g = (packed >>> 16) & 0xff;
	const b = (packed >>> 8) & 0xff;
	return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The nearest colour a diffusion model has a word for.
 *
 * Measured against SD1.5: a prompt saying "#ff00ff" produces no magenta at
 * all — the model does not read hex, and the request for a flat backdrop is
 * silently lost, which is why background auto-detect had to exist. The same
 * prompt saying "magenta" produces a flat magenta field the chroma key
 * removes cleanly.
 *
 * A short table rather than a full colour-naming library: the background is a
 * chroma key, so in practice it is one of a handful of saturated colours
 * chosen precisely because nothing in the art will be that colour.
 */
const COLOUR_WORDS: ReadonlyArray<{ rgb: [number, number, number]; name: string }> = [
	{ rgb: [255, 0, 255], name: 'magenta' },
	{ rgb: [0, 255, 0], name: 'bright green' },
	{ rgb: [0, 255, 255], name: 'cyan' },
	{ rgb: [255, 0, 0], name: 'red' },
	{ rgb: [0, 0, 255], name: 'blue' },
	{ rgb: [255, 255, 0], name: 'yellow' },
	{ rgb: [255, 255, 255], name: 'white' },
	{ rgb: [0, 0, 0], name: 'black' },
	{ rgb: [128, 128, 128], name: 'grey' }
];

export function colourWord(packed: number): string {
	const r = (packed >>> 24) & 0xff;
	const g = (packed >>> 16) & 0xff;
	const b = (packed >>> 8) & 0xff;
	let best = COLOUR_WORDS[0];
	let bestD = Number.POSITIVE_INFINITY;
	for (const c of COLOUR_WORDS) {
		const d = (r - c.rgb[0]) ** 2 + (g - c.rgb[1]) ** 2 + (b - c.rgb[2]) ** 2;
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return best.name;
}

/**
 * The anchor's own prompt: several distinct subjects in one frame.
 *
 * One image containing several things is far easier for a model than several
 * images that agree with each other, and it demonstrates the style ACROSS
 * subject types — which is what a reference has to show, since the assets
 * conditioned on it will be characters and props and ground alike.
 *
 * Three rules here were paid for in bad generations against SD1.5, each
 * reproducible at a fixed seed:
 *
 *   1. THE STYLE GOES FIRST. Leading with the subjects and appending the
 *      style produced a competent oil painting of a chair; leading with
 *      "16-bit pixel art, flat shading, bold dark outline" produced pixel art
 *      of the same subjects. Whatever opens the prompt decides the medium,
 *      and the medium is the entire point of a style anchor.
 *   2. NO "REFERENCE SHEET", NO "2x2 GRID". That phrasing produced a flat
 *      brown floor plan — abstract rectangles, no subject at all — twice out
 *      of two. The model reads "sheet" and "grid" as the picture's content.
 *   3. NO GROUND OR TERRAIN AS A SUBJECT. Asking for "a patch of ground"
 *      among the subjects made the model render the whole background as
 *      grass, destroying the flat backdrop the key depends on.
 */
export function anchorPrompt(spec: AssetSpec, profile: NormalizeProfile): string {
	const bg = colourWord(profile.background.color);
	return [
		`${spec.style.prompt}.`,
		`A sprite sheet of separate game sprites on a plain solid ${bg} background:`,
		`${anchorSubjects(spec)}.`,
		`Each sprite small, centred and isolated, surrounded by empty ${bg} space.`
	].join(' ');
}

/** How many of the spec's own subjects the anchor is asked to show. */
const ANCHOR_SUBJECTS = 4;

/**
 * The subjects the anchor sheet shows: the spec's own, wherever possible.
 *
 * This is what makes the palette USABLE, and the first real run proved the
 * point by failing without it. A generic sheet of "a character, a weapon, a
 * piece of furniture" in a muted earthy style yielded a palette of browns,
 * greens and creams — with no grey for an iron sword and no red for a health
 * potion. Every asset then measured as wildly off-style against a palette
 * that never contained its colours, and the run produced nothing.
 *
 * The anchor exists to define the style for THIS spec's assets, so it should
 * be made of them. One sprite per distinct subject, sampled across kinds so a
 * spec of forty swords does not produce a sheet of four swords.
 *
 * Textures are deliberately excluded. Naming ground or terrain among the
 * subjects makes the model render the whole frame as that texture, which
 * destroys the flat backdrop the chroma key depends on — the same rule the
 * generic list had to obey. A spec of nothing but textures therefore falls
 * back to the generic list rather than sabotaging its own anchor.
 */
export function anchorSubjects(spec: AssetSpec): string {
	const usable = spec.entries.filter((e) => e.kind !== 'texture' && e.prompt.trim().length > 0);
	if (usable.length === 0) {
		return 'a character, a hand-held weapon, a piece of furniture, and a small prop';
	}
	// Round-robin by kind, so a long run of one kind does not crowd out the
	// others and leave their colours out of the palette.
	const byKind = new Map<string, string[]>();
	for (const e of usable) {
		byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.prompt.trim()]);
	}
	const queues = [...byKind.values()];
	const picked: string[] = [];
	for (let i = 0; picked.length < ANCHOR_SUBJECTS; i++) {
		const before = picked.length;
		for (const q of queues) {
			if (picked.length >= ANCHOR_SUBJECTS) break;
			if (i < q.length) picked.push(q[i]);
		}
		if (picked.length === before) break;
	}
	return picked.join(', ');
}

/**
 * The anchor's negative prompt.
 *
 * `ANCHOR_NEGATIVE`'s second half is the antidote to rule 2 above: without
 * naming the abstractions explicitly, "sheet" and "grid" pull the model
 * toward floor plans and blueprints even when the words are gone.
 */
export const ANCHOR_NEGATIVE =
	'photo, 3d render, text, watermark, busy background, ' +
	'grid, floor plan, map, blueprint, abstract, rectangles, maze, pattern, landscape, scenery';

export function anchorNegativePrompt(spec: AssetSpec): string {
	return [spec.style.negativePrompt ?? '', ANCHOR_NEGATIVE]
		.filter((s) => s.trim().length > 0)
		.join(', ');
}

/**
 * The sheet's edge: a 2x2 grid of generation-resolution cells, clamped the
 * same way an entry's generation is.
 *
 * The clamp matters here too — a 512px target with the default upscale asks
 * for 2048, which is the image the clamp exists to prevent.
 */
export function anchorEdge(profile: NormalizeProfile, maxEdge: number): number {
	return Math.min(profile.target_size * profile.upscale * 2, maxEdge);
}

export interface AnchorDeps {
	workingDir: string;
	profile: NormalizeProfile;
	/** Regenerations allowed. Not the per-entry budget; they are different questions. */
	anchorAttempts: number;
	attended: boolean;
	signal: AbortSignal;
	/** Put the sheet and the spec summary in front of the user. */
	present: (markdown: string) => void;
	readFile: (relPath: string) => Promise<string | null>;
	readBytes: (relPath: string) => Promise<Uint8Array | null>;
	writeFile: (relPath: string, content: string) => Promise<void>;
	writeBytes: (relPath: string, bytes: Uint8Array) => Promise<void>;
}

export interface AnchorResult {
	outcome: AnchorOutcome;
	/** The reference every entry is conditioned on. */
	image: Uint8Array;
	/** The spec with the palette filled in. */
	spec: AssetSpec;
}

/** A short "what is about to be made", shown beside the sheet. */
export function specSummary(spec: AssetSpec): string {
	const byKind = spec.entries.reduce<Record<string, number>>((acc, e) => {
		acc[e.kind] = (acc[e.kind] ?? 0) + 1;
		return acc;
	}, {});
	const counts = Object.entries(byKind)
		.map(([k, n]) => `${n} ${k}`)
		.join(', ');
	const names = spec.entries.slice(0, 8).map((e) => e.id);
	const more =
		spec.entries.length > names.length ? `, and ${spec.entries.length - names.length} more` : '';
	return `${spec.entries.length} asset(s) — ${counts}: ${names.join(', ')}${more}`;
}

export async function establishAnchor(
	spec: AssetSpec,
	deps: AnchorDeps,
	maxEdge: number
): Promise<AnchorResult> {
	// Reuse first, always. Generating is the exception — this ordering is what
	// makes a run six months from now match the one that shipped.
	const reused = await tryReuse(spec, deps);
	if (reused) return reused;

	const backend = resolveImageBackend();
	const edge = anchorEdge(deps.profile, maxEdge);
	let attempts = 0;
	let seed: number | null = null;
	let result: ImageResult | null = null;
	let approval: AnchorOutcome['approval'] = 'auto';

	for (;;) {
		attempts++;
		result = await backend.generate(
			{
				prompt: anchorPrompt(spec, deps.profile),
				negativePrompt: anchorNegativePrompt(spec),
				width: edge,
				height: edge,
				seed,
				model: spec.style.model,
				loras: spec.style.loras
			},
			{ signal: deps.signal }
		);
		if (!deps.attended) break;

		// Show the sheet and the spec together: this is the run's only
		// checkpoint, so it answers both open questions at once — what is
		// about to be made, and what it will look like.
		const img = result.images[0];
		const hash = await invoke<string>('image_store_bytes', {
			bytes: Array.from(img.bytes),
			mime: img.mimeType,
			width: img.width,
			height: img.height
		});
		// Registered, not merely stored. The renderer drops a markdown image it
		// cannot resolve — deliberately, so a failed fetch looks like a slow one
		// — and nothing resolves an image the app generated itself.
		const url = registerLocalImage(hash, {
			mime: img.mimeType,
			width: img.width,
			height: img.height,
			source: 'style anchor'
		});
		deps.present(`${url ? `![Style anchor](${url})\n\n` : ''}${specSummary(spec)}`);
		const last = attempts >= deps.anchorAttempts;
		const answer = await askUserQuestion(
			{
				// The sheet goes IN the question. It used to be shown only in the
				// run timeline, which this modal then covered.
				imageUrl: url ?? undefined,
				question:
					`This is the style every asset will be generated in, and the list it will be ` +
					`applied to. Approve to generate them${last ? '' : ', or ask for a different anchor'}.`,
				options: [
					{ label: 'Approve', description: 'Use this style.', recommended: true },
					...(last ? [] : [{ label: 'Regenerate', description: 'Try a different anchor.' }]),
					{ label: 'Stop', description: 'End the run so I can edit the spec first.' }
				]
			},
			deps.signal
		);
		const choice = answer.kind === 'selected' ? answer.labels[0] : 'Stop';
		if (choice === 'Approve') {
			approval = 'approved';
			break;
		}
		if (choice === 'Regenerate' && !last) {
			// A new seed, or the same picture comes back and the button looks
			// broken.
			seed = Math.floor(Math.random() * 2_147_483_647);
			continue;
		}
		// Stop, a dismissed modal, or an answer we did not offer — including a
		// regenerate on the last attempt. The bound lives here rather than in
		// the option list, because a loop that trusts its own UI to terminate
		// it does not terminate; and proceeding on an answer we do not
		// understand means generating a whole set in a style nobody approved.
		throw new DOMException('Aborted', 'AbortError');
	}

	const image = result.images[0].bytes;
	// Exclude both the colour the prompt asked for and the one the sheet
	// actually has round its edge; the model rarely produces the former.
	const palette = await extractPalette(image, deps.profile.palette_size, deps.profile.background);

	const recipe: AnchorRecipe = {
		version: 1,
		prompt: anchorPrompt(spec, deps.profile),
		negativePrompt: anchorNegativePrompt(spec),
		// The RESOLVED seed, not the null we may have sent: a recipe recording
		// "whatever you like" reproduces nothing.
		seed: result.meta.seed,
		backend: result.meta.backend,
		model: result.meta.model,
		sampler: result.meta.sampler,
		loras: result.meta.loras,
		size: edge,
		palette,
		createdAt: new Date().toISOString()
	};

	await deps.writeBytes(spec.anchor.image, image);
	await deps.writeFile(spec.anchor.recipe, `${JSON.stringify(recipe, null, 2)}\n`);

	return {
		outcome: {
			source: 'generated',
			approval,
			attempts,
			paletteSize: palette.length,
			imagePath: spec.anchor.image,
			recipePath: spec.anchor.recipe
		},
		image,
		spec: { ...spec, normalize: { ...spec.normalize, palette } }
	};
}

/**
 * The committed anchor, when there is one.
 *
 * The palette copy is not optional. A chained run derives a fresh spec every
 * time, and a fresh spec ships an empty palette — so without copying the
 * recipe's palette back, a reused anchor reaches the generation loop with
 * nothing to quantize against and the mechanical coherence layer is silently
 * off for the whole run.
 */
async function tryReuse(spec: AssetSpec, deps: AnchorDeps): Promise<AnchorResult | null> {
	const image = await deps.readBytes(spec.anchor.image);
	if (!image || image.length === 0) return null;
	const raw = await deps.readFile(spec.anchor.recipe);
	if (raw === null) return null;
	let recipe: AnchorRecipe;
	try {
		recipe = JSON.parse(raw) as AnchorRecipe;
	} catch {
		// A corrupt recipe falls back to generating rather than failing: the
		// run can still produce a coherent set, it just cannot reuse this one.
		return null;
	}
	if (!Array.isArray(recipe.palette) || recipe.palette.length === 0) return null;

	return {
		outcome: {
			source: 'reused',
			approval: 'approved',
			attempts: 0,
			paletteSize: recipe.palette.length,
			imagePath: spec.anchor.image,
			recipePath: spec.anchor.recipe
		},
		image,
		spec: { ...spec, normalize: { ...spec.normalize, palette: recipe.palette } }
	};
}
