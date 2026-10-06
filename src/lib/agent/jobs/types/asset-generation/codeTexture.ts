/**
 * A texture drawn by code from its recipe, in place of the image model.
 *
 * Kept apart from `generate.ts` like the sheet loop is: the single-image path
 * and this one share bookkeeping (`record`), not steps.
 */

import type { AssetSpec } from '#lib/assets/spec/types.ts';
import type { CheckReport } from '#lib/ipc/gen/CheckReport.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import { judgeUnavailable, maybeJudge } from './gate';
import type { CodeTextureDeps, GenerateDeps } from './generate';
import { escapesWorkdir, isCancellation } from './guards';
import { errMessage } from '#lib/utils/error.ts';
import { textureSeed, variantPaths } from './recipes';
import type { EntryOutcome } from './types';

type Outcome = Omit<EntryOutcome, 'id' | 'durationMs'>;

/** One more sentence for the judge, about a tile drawn by code. */
export const CODE_TEXTURE_HINT =
	'This tile was drawn by code from simple layers, not painted: judge only ' +
	'whether it reads as the material, seen from directly above, not its detail.';

export interface CodeTextureContext {
	spec: AssetSpec;
	deps: GenerateDeps;
	code: CodeTextureDeps;
	record: (index: number, started: number, outcome: Outcome, report: CheckReport | null) => void;
}

/**
 * A texture drawn by code: render its variants, write them, and show the
 * judge the first. One no gets one revised recipe; a second no keeps the
 * tiles and marks them rejected, like any other asset that never passed.
 */
export async function runCodeTexture(index: number, ctx: CodeTextureContext): Promise<void> {
	const { spec, deps, code, record } = ctx;
	if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	const entry = spec.entries[index];
	const started = Date.now();
	const fail = (reason: string) =>
		record(
			index,
			started,
			{ status: 'failed', attempts: 0, seed: null, degraded: [], reason },
			null
		);
	if (escapesWorkdir(entry.out)) {
		fail(`The output path ${entry.out} escapes the working directory.`);
		return;
	}
	if (await deps.exists(entry.out)) {
		const outcome = { status: 'skipped' as const, attempts: 0, seed: null, degraded: [] };
		record(index, started, outcome, null);
		return;
	}
	if (!entry.recipe) {
		fail(code.recipeFailures.get(entry.id) ?? 'No recipe was written for this texture.');
		return;
	}
	const seed = textureSeed(entry);
	const paths = variantPaths(entry.out, code.variants);
	const draw = async (recipe: TextureRecipe): Promise<Uint8Array> => {
		const tiles = await code.render(recipe, seed, code.variants);
		for (const [k, bytes] of tiles.entries()) await deps.writeBytes(paths[k], bytes);
		return tiles[0];
	};

	let recipe = entry.recipe;
	let drawn = entry.drawn;
	let revised: TextureRecipe | undefined;
	const degraded: string[] = [];
	try {
		let first = await draw(recipe);
		for (let attempt = 1; ; attempt++) {
			// Judged against what the recipe draws, when the model said: the
			// prompt may name details no recipe can draw ("graffiti-covered").
			const subject = drawn ? { ...entry, prompt: drawn } : entry;
			const judged = await maybeJudge(subject, first, deps.judge, false, CODE_TEXTURE_HINT);
			if (judged.unavailable) degraded.push(judgeUnavailable(judged.unavailable));
			const verdict = judged.verdict;
			const base = {
				attempts: attempt,
				seed,
				degraded,
				codeDrawn: true,
				variants: paths,
				...(revised ? { recipe: revised, ...(drawn ? { drawn } : {}) } : {})
			};
			if (!verdict || verdict.ok) {
				record(index, started, { status: 'done', ...base }, null);
				return;
			}
			const next =
				attempt === 1 ? await code.revise({ ...entry, recipe, drawn }, verdict.reason) : null;
			if (!next) {
				// The tiles stay: they tile, which is more than the image
				// model's would. The spec marks them for Review assets.
				const outcome = {
					status: 'unresolved' as const,
					kept: true,
					reason: verdict.reason,
					...base
				};
				record(index, started, outcome, null);
				return;
			}
			recipe = revised = next.recipe;
			drawn = next.drawn || drawn;
			first = await draw(recipe);
		}
	} catch (e) {
		if (isCancellation(e)) throw e;
		fail(errMessage(e));
	}
}
