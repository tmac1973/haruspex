/**
 * The recipe stage: the model writes how each texture is drawn, and code
 * draws it.
 *
 * Recipes are asked for together, in one turn, so a set of floors and walls
 * is designed as a set. Each is checked by Rust before anything is drawn; a
 * refused one is asked for once more with the refusal quoted, then given up
 * on, and that texture fails with the reason in the report.
 */

import type { AssetEntry, AssetSpec, TransitionEntry } from '#lib/assets/spec/types.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import type { TransitionEdge } from '#lib/ipc/gen/TransitionEdge.ts';
import type { TransitionView } from '#lib/ipc/gen/TransitionView.ts';
import {
	edgeRevisionPrompt,
	recipePrompt,
	type TransitionLine
} from '#lib/agent/jobs/types/asset-generation/prompts.ts';
import type { Submitted } from '#lib/agent/jobs/types/asset-generation/tools.ts';
import { seedOf } from '#lib/assets/texture.ts';

export { variantPaths } from '#lib/assets/texture.ts';

export interface RecipeDeps {
	/**
	 * One model turn with `prompt`; the recipes it submitted, by id. `image`
	 * goes in ahead of the prompt, when the model can see.
	 */
	ask: (prompt: string, image?: Uint8Array) => Promise<Submitted>;
	/** Whether the recipe model can see an image put before its prompt. */
	visionSupported: boolean;
	/** Null when the recipe is good, else what is wrong with it. */
	validate: (recipe: unknown) => Promise<string | null>;
	/** Null when a set's edge settings are good, else what is wrong with them. */
	validateEdge: (view: TransitionView, edge: unknown) => Promise<string | null>;
}

/** A recipe that passed Rust's check, and the model's line on what it draws. */
export interface DrawnRecipe {
	recipe: TextureRecipe;
	drawn: string;
}

export interface RecipeResult {
	spec: AssetSpec;
	/** Ids given a recipe this time. */
	written: string[];
	/** Ids left without one, and why. */
	failed: Map<string, string>;
}

/** The transition sets that still need edge settings. */
export function needingEdges(spec: AssetSpec): TransitionEntry[] {
	return (spec.transitions ?? []).filter((t) => !t.edge);
}

/** A set as the recipe stage lists it. */
function lineOf(t: TransitionEntry): TransitionLine {
	return {
		id: t.id,
		view: t.view,
		a: t.a,
		...(t.b ? { b: t.b } : {}),
		...(t.cap ? { cap: t.cap } : {}),
		...(t.notes ? { notes: t.notes } : {})
	};
}

/** The texture entries that still need a recipe. */
export function needingRecipes(spec: AssetSpec): AssetEntry[] {
	return spec.entries.filter((e) => e.kind === 'texture' && !e.recipe);
}

/** The set's palette, packed `0xRRGGBBAA`, if the anchor gave it one. */
function paletteOf(spec: AssetSpec): number[] {
	return spec.normalize.palette ?? [];
}

interface Asked {
	good: Map<string, DrawnRecipe>;
	refused: Map<string, string>;
	edges: Map<string, TransitionEdge>;
}

async function askFor(
	spec: AssetSpec,
	entries: AssetEntry[],
	deps: RecipeDeps,
	feedback?: Map<string, string>,
	image?: Uint8Array,
	sets: TransitionEntry[] = []
): Promise<Asked> {
	const shown = image !== undefined && deps.visionSupported;
	// The ground each texture caps, when a side set uses it as a cap.
	const capOf = new Map((spec.transitions ?? []).filter((t) => t.cap).map((t) => [t.cap!, t.a]));
	const prompt = recipePrompt(
		entries.map((e) => ({
			id: e.id,
			prompt: e.prompt,
			...(capOf.has(e.id) ? { capOf: capOf.get(e.id) } : {})
		})),
		paletteOf(spec),
		spec.style.prompt,
		feedback,
		shown,
		sets.map(lineOf)
	);
	const submitted = await deps.ask(prompt, shown ? image : undefined);
	const got = submitted.recipes;
	const good = new Map<string, DrawnRecipe>();
	const refused = new Map<string, string>();
	const edges = new Map<string, TransitionEdge>();
	for (const t of sets) {
		const edge = submitted.edges.get(t.id);
		if (edge === undefined) {
			refused.set(t.id, 'No edge was submitted for it.');
			continue;
		}
		const why = await deps.validateEdge(t.view, edge);
		if (why) refused.set(t.id, `${why} The edge was: ${JSON.stringify(edge)}`);
		else edges.set(t.id, edge as TransitionEdge);
	}
	for (const e of entries) {
		const r = got.get(e.id);
		if (!r) {
			refused.set(e.id, 'No recipe was submitted for it.');
			continue;
		}
		const why = await deps.validate(r.recipe);
		if (why) refused.set(e.id, `${why} The recipe was: ${JSON.stringify(r.recipe)}`);
		else good.set(e.id, { recipe: r.recipe as unknown as TextureRecipe, drawn: r.drawn });
	}
	return { good, refused, edges };
}

/**
 * A recipe for every texture entry that has none, and edge settings for every
 * transition set that has none, in one turn; one retry for refusals. A set
 * still without an edge takes the defaults rather than failing: its
 * materials are what matter, and they are drawn either way.
 */
export async function writeRecipes(spec: AssetSpec, deps: RecipeDeps): Promise<RecipeResult> {
	const todo = needingRecipes(spec);
	const sets = needingEdges(spec);
	if (todo.length === 0 && sets.length === 0) return { spec, written: [], failed: new Map() };

	const first = await askFor(spec, todo, deps, undefined, undefined, sets);
	const recipes = new Map(first.good);
	const edges = new Map(first.edges);
	let failed = first.refused;
	if (failed.size > 0) {
		const again = todo.filter((e) => failed.has(e.id));
		const setsAgain = sets.filter((t) => failed.has(t.id));
		const second = await askFor(spec, again, deps, failed, undefined, setsAgain);
		for (const [id, r] of second.good) recipes.set(id, r);
		for (const [id, e] of second.edges) edges.set(id, e);
		failed = second.refused;
	}
	for (const t of sets) failed.delete(t.id);
	return {
		spec: {
			...spec,
			entries: spec.entries.map((e) => {
				const r = recipes.get(e.id);
				return r ? { ...e, recipe: r.recipe, ...(r.drawn ? { drawn: r.drawn } : {}) } : e;
			}),
			...(spec.transitions
				? {
						transitions: spec.transitions.map((t) =>
							t.edge ? t : { ...t, edge: edges.get(t.id) ?? {} }
						)
					}
				: {})
		},
		written: [...recipes.keys(), ...sets.map((t) => t.id)],
		failed
	};
}

/**
 * One set's edge again, after the judge said no, looking at the set laid out
 * as a map when the model can see. Null when it gave nothing usable; the
 * caller keeps the sheet it has.
 */
export async function reviseEdge(
	t: TransitionEntry,
	reason: string,
	deps: RecipeDeps,
	preview?: Uint8Array
): Promise<TransitionEdge | null> {
	const shown = preview !== undefined && deps.visionSupported;
	const prompt = edgeRevisionPrompt(lineOf(t), reason, t.edge, shown);
	const { edges } = await deps.ask(prompt, shown ? preview : undefined);
	const edge = edges.get(t.id);
	if (edge === undefined || (await deps.validateEdge(t.view, edge))) return null;
	return edge as TransitionEdge;
}

/**
 * One texture's recipe again, after the judge said no. `preview` is the tile
 * laid 3×3 as the judge saw it, shown to a model that can see. Null when the
 * model gave nothing usable; the caller keeps the tiles it has.
 */
export async function reviseRecipe(
	spec: AssetSpec,
	entry: AssetEntry,
	reason: string,
	deps: RecipeDeps,
	preview?: Uint8Array
): Promise<DrawnRecipe | null> {
	const feedback = new Map([
		[
			entry.id,
			`A reviewer looked at the tiles and said: ${reason} ` +
				`The recipe was: ${JSON.stringify(entry.recipe)}`
		]
	]);
	const { good } = await askFor(spec, [entry], deps, feedback, preview);
	return good.get(entry.id) ?? null;
}

/**
 * A texture's seed: the entry's pinned one, else one from its id, so a re-run
 * draws the same tiles and two textures never share noise.
 */
export function textureSeed(entry: AssetEntry): number {
	if (typeof entry.seed === 'number' && Number.isFinite(entry.seed)) return entry.seed >>> 0;
	return seedOf(entry.id);
}

/**
 * The spec after a run drew textures in code: each gets its tile list, and a
 * recipe the judge made the run revise replaces the old one. Null when
 * nothing changed.
 */
export function applyCodeTextures(
	spec: AssetSpec,
	outcomes: Array<{
		id: string;
		codeDrawn?: boolean;
		variants?: string[];
		recipe?: TextureRecipe;
		drawn?: string;
	}>
): AssetSpec | null {
	const byId = new Map(outcomes.filter((o) => o.codeDrawn).map((o) => [o.id, o]));
	if (byId.size === 0) return null;
	let changed = false;
	const entries = spec.entries.map((e): AssetEntry => {
		const o = byId.get(e.id);
		if (!o) return e;
		const variants = o.variants ?? e.variants;
		const recipe = o.recipe ?? e.recipe;
		const drawn = o.drawn ?? e.drawn;
		if (
			JSON.stringify(variants) === JSON.stringify(e.variants) &&
			recipe === e.recipe &&
			drawn === e.drawn
		)
			return e;
		changed = true;
		return { ...e, variants, recipe, ...(drawn ? { drawn } : {}) };
	});
	return changed ? { ...spec, entries } : null;
}
