/**
 * The recipe stage: the model writes how each texture is drawn, and code
 * draws it.
 *
 * Recipes are asked for together, in one turn, so a set of floors and walls
 * is designed as a set. Each is checked by Rust before anything is drawn; a
 * refused one is asked for once more with the refusal quoted, then given up
 * on, and that texture fails with the reason in the report.
 */

import type { AssetEntry, AssetSpec } from '#lib/assets/spec/types.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import { recipePrompt } from './prompts';
import type { SubmittedRecipe } from './tools';

export interface RecipeDeps {
	/** One model turn with `prompt`; the recipes it submitted, by id. */
	ask: (prompt: string) => Promise<Map<string, SubmittedRecipe>>;
	/** Null when the recipe is good, else what is wrong with it. */
	validate: (recipe: unknown) => Promise<string | null>;
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

/** The texture entries that still need a recipe. */
export function needingRecipes(spec: AssetSpec): AssetEntry[] {
	return spec.entries.filter((e) => e.kind === 'texture' && !e.recipe);
}

/** The set's palette, packed `0xRRGGBBAA`, if the anchor gave it one. */
function paletteOf(spec: AssetSpec): number[] {
	return spec.normalize.palette ?? [];
}

async function askFor(
	spec: AssetSpec,
	entries: AssetEntry[],
	deps: RecipeDeps,
	feedback?: Map<string, string>
): Promise<{ good: Map<string, DrawnRecipe>; refused: Map<string, string> }> {
	const prompt = recipePrompt(
		entries.map((e) => ({ id: e.id, prompt: e.prompt })),
		paletteOf(spec),
		spec.style.prompt,
		feedback
	);
	const got = await deps.ask(prompt);
	const good = new Map<string, DrawnRecipe>();
	const refused = new Map<string, string>();
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
	return { good, refused };
}

/** A recipe for every texture entry that has none; one retry for refusals. */
export async function writeRecipes(spec: AssetSpec, deps: RecipeDeps): Promise<RecipeResult> {
	const todo = needingRecipes(spec);
	if (todo.length === 0) return { spec, written: [], failed: new Map() };

	const first = await askFor(spec, todo, deps);
	const recipes = new Map(first.good);
	let failed = first.refused;
	if (failed.size > 0) {
		const again = todo.filter((e) => failed.has(e.id));
		const second = await askFor(spec, again, deps, failed);
		for (const [id, r] of second.good) recipes.set(id, r);
		failed = second.refused;
	}
	return {
		spec: {
			...spec,
			entries: spec.entries.map((e) => {
				const r = recipes.get(e.id);
				return r ? { ...e, recipe: r.recipe, ...(r.drawn ? { drawn: r.drawn } : {}) } : e;
			})
		},
		written: [...recipes.keys()],
		failed
	};
}

/**
 * One texture's recipe again, after the judge said no. Null when the model
 * gave nothing usable; the caller keeps the tiles it has.
 */
export async function reviseRecipe(
	spec: AssetSpec,
	entry: AssetEntry,
	reason: string,
	deps: RecipeDeps
): Promise<DrawnRecipe | null> {
	const feedback = new Map([
		[
			entry.id,
			`A reviewer looked at the tiles and said: ${reason} ` +
				`The recipe was: ${JSON.stringify(entry.recipe)}`
		]
	]);
	const { good } = await askFor(spec, [entry], deps, feedback);
	return good.get(entry.id) ?? null;
}

/** Every tile file of a texture with `n` variants: `out` first, then `<stem>_k`. */
export function variantPaths(out: string, n: number): string[] {
	const slash = out.lastIndexOf('/');
	const dot = out.lastIndexOf('.');
	const [stem, ext] = dot > slash ? [out.slice(0, dot), out.slice(dot)] : [out, ''];
	return [out, ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => `${stem}_${i + 1}${ext}`)];
}

/**
 * A texture's seed: the entry's pinned one, else one from its id, so a re-run
 * draws the same tiles and two textures never share noise.
 */
export function textureSeed(entry: AssetEntry): number {
	if (typeof entry.seed === 'number' && Number.isFinite(entry.seed)) return entry.seed >>> 0;
	// FNV-1a, 32-bit.
	let h = 0x811c9dc5;
	for (const ch of entry.id) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
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
