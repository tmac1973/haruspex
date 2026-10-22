/**
 * `make_asset` with `kind: "transition"`: the 16 edge tiles where two of the
 * project's textures meet (top), or platform ground against air with a cap
 * on its upward faces (side), drawn by code from the recipes the assistant
 * wrote for those textures (`assets/texture.ts`).
 */
import { errMessage } from '#lib/utils/error.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { paletteFor, writeAsset, type Target } from '#lib/agent/tools/_assetIo.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import {
	renderTransition,
	seedOf,
	transitionFiles,
	transitionMap,
	transitionPreview,
	validateRecipe,
	validateTransitionEdge
} from '#lib/assets/texture.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import type { TransitionEdge } from '#lib/ipc/gen/TransitionEdge.ts';
import type { TransitionView } from '#lib/ipc/gen/TransitionView.ts';
import { pngDataUrl as dataUrl } from '#lib/utils/base64.ts';

type Recipe = Record<string, unknown>;

export interface TransitionInput {
	view: TransitionView;
	/** Material A (top) or the solid (side). */
	recipe: Recipe;
	/** Material B (top) or the cap (side, optional). */
	other: Recipe | null;
	edge: unknown;
	/** The texture files the recipes were drawn into, to match their seeds. */
	seedFrom: string | null;
	seedFromB: string | null;
}

function object(v: unknown): Recipe | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Recipe) : null;
}

function text(v: unknown): string | null {
	return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The call's transition arguments, or what is missing from them. */
export function parseTransition(args: Record<string, unknown>): TransitionInput | string {
	const view = args.view === 'top' || args.view === 'side' ? args.view : null;
	if (!view)
		return 'A transition needs "view": "top" for two ground textures, "side" for platforms.';
	const recipe = object(args.recipe);
	if (!recipe) return 'A transition needs "recipe": the first material\'s, or the solid\'s.';
	const other = view === 'top' ? object(args.recipe_b) : object(args.cap);
	if (view === 'top' && !other) return 'A top transition needs "recipe_b": the second material\'s.';
	return {
		view,
		recipe,
		other,
		edge: args.edge ?? {},
		seedFrom: text(args.seed_from),
		seedFromB: view === 'top' ? text(args.seed_from_b) : null
	};
}

/** Each recipe's refusal from Rust, named by its argument; null when all pass. */
async function refusal(t: TransitionInput): Promise<string | null> {
	const named: Array<[string, Recipe | null]> = [
		['recipe', t.recipe],
		[t.view === 'top' ? 'recipe_b' : 'cap', t.other]
	];
	for (const [name, r] of named) {
		if (!r) continue;
		const why = await validateRecipe(r);
		if (why) return `${name} was refused: ${why}`;
	}
	const why = await validateTransitionEdge(t.view, t.edge);
	return why ? `edge was refused: ${why}` : null;
}

/** Draw the set, write the sheet and its JSON map, and show the model the map. */
export async function makeTransition(
	t: TransitionInput,
	size: number,
	paletteFrom: string | null,
	target: Target,
	ctx: ToolContext
) {
	const { path, overwrite, io } = target;
	const refused = await refusal(t);
	if (refused) return toolResult(toolError(refused));

	const [sheetPath, jsonPath] = transitionFiles(path);
	for (const p of [sheetPath, jsonPath]) {
		const unwritable = await writeAsset(p, new Uint8Array(), overwrite, true, io);
		if (unwritable) return toolResult(toolError(unwritable));
	}
	const palette = await paletteFor(paletteFrom, target);
	if (typeof palette === 'string') return toolResult(palette);

	// A material's tiles were seeded from the file they went to; the same
	// seed makes the set's plain tiles those tiles exactly.
	const seedFor = (from: string | null, tag: string) =>
		seedOf(from ? resolveShellPath(from, target.cwd) : `${path}#${tag}`);
	const seeds = {
		a: seedFor(t.seedFrom, 'a'),
		other: t.view === 'top' ? seedFor(t.seedFromB, 'b') : seedOf(`${path}#cap`)
	};
	let sheet: Uint8Array;
	try {
		sheet = await renderTransition(
			t.view,
			t.recipe as unknown as TextureRecipe,
			t.other as unknown as TextureRecipe | null,
			t.edge as TransitionEdge,
			size,
			seeds,
			palette ?? []
		);
	} catch (e) {
		return toolResult(toolError(`Could not draw it: ${errMessage(e)}`));
	}
	const failed = await writeSet(t, size, sheet, [sheetPath, jsonPath], target);
	if (failed) return toolResult(toolError(failed));

	const url = dataUrl(await transitionPreview(t.view, sheet, size));
	const sees = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
	if (sees) ctx.pendingImages.push({ path: sheetPath, dataUrl: url });
	const which =
		t.view === 'top'
			? 'In the JSON, "a" is recipe and "b" is recipe_b.'
			: 'In the JSON, "solid" is recipe and "air" is empty.';
	return toolResult(
		[
			`Wrote ${sheetPath} and ${jsonPath} (16 tiles, ${size}×${size} each, in a 4×4 sheet; the JSON names each tile's corners).`,
			which,
			...(sees
				? [
						'The image shows the set laid out as a small map. If a border looks like a straight ' +
							'seam or the rim is too loud, change edge and draw again with overwrite: true.'
					]
				: [])
		].join(' '),
		url
	);
}

/** Write the sheet and its JSON map; the refusal, or null. */
async function writeSet(
	t: TransitionInput,
	size: number,
	sheet: Uint8Array,
	[sheetPath, jsonPath]: [string, string],
	{ overwrite, io }: Target
): Promise<string | null> {
	const names =
		t.view === 'top'
			? transitionMap('top', size, 'a', 'b')
			: transitionMap('side', size, 'solid', t.other ? 'cap' : undefined);
	const json = new TextEncoder().encode(JSON.stringify(names, null, '\t') + '\n');
	return (
		(await writeAsset(sheetPath, sheet, overwrite, false, io)) ??
		(await writeAsset(jsonPath, json, overwrite, false, io))
	);
}
