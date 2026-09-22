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
import { extractPalette } from '$lib/assets/normalize';
import type { AssetSpec, AnchorRecipe } from '$lib/assets/spec/types';
import { resolveImageBackend } from '$lib/image';
import type { ImageResult } from '$lib/image/types';
import type { NormalizeProfile } from '$lib/ipc/gen/NormalizeProfile';
import type { AnchorOutcome } from './types';

/** `0xRRGGBBAA` as the `#RRGGBB` a prompt can say out loud. */
export function hexColor(packed: number): string {
	const r = (packed >>> 24) & 0xff;
	const g = (packed >>> 16) & 0xff;
	const b = (packed >>> 8) & 0xff;
	return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The anchor's own prompt: several distinct subjects in one frame.
 *
 * One image containing four things is far easier for a model than four images
 * that agree with each other, and it demonstrates the style applied ACROSS
 * subject types — which is what a reference has to show, since the assets
 * conditioned on it will be characters and props and ground alike.
 */
export function anchorPrompt(spec: AssetSpec, profile: NormalizeProfile): string {
	const bg = hexColor(profile.background.color);
	return [
		`A reference sheet showing four separate subjects arranged in a 2x2 grid:`,
		`a character, a hand-held object, a piece of furniture, and a patch of ground.`,
		`Each clearly separated from the others, on a plain flat ${bg} background.`,
		spec.style.prompt
	].join(' ');
}

export function anchorNegativePrompt(spec: AssetSpec): string {
	return [spec.style.negativePrompt ?? '', 'photo, 3d render, text, watermark, busy background']
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
		const hash = await invoke<string>('image_store_bytes', {
			bytes: Array.from(result.images[0].bytes),
			mime: result.images[0].mimeType,
			width: result.images[0].width,
			height: result.images[0].height
		});
		deps.present(`![Style anchor](haruspex-img://localhost/${hash})\n\n${specSummary(spec)}`);
		const last = attempts >= deps.anchorAttempts;
		const answer = await askUserQuestion(
			{
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
