/**
 * A transition set drawn in the asset job: the 16 edge tiles where two of the
 * spec's textures meet, or platform ground against air, drawn by code from
 * those textures' recipes (`assets/texture.ts`).
 *
 * Kept apart from `codeTexture.ts` as that is from `generate.ts`: the steps
 * rhyme, but a set has no recipe of its own. Only its edge settings are its
 * own, so a judge's no revises those, once, and never a material.
 */

import type { AssetEntry, AssetSpec, TransitionEntry } from '#lib/assets/spec/types.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import type { TransitionEdge } from '#lib/ipc/gen/TransitionEdge.ts';
import type { TransitionView } from '#lib/ipc/gen/TransitionView.ts';
import { transitionFiles, transitionMap } from '#lib/assets/texture.ts';
import { escapesWorkdir, isCancellation } from '#lib/agent/jobs/types/asset-generation/guards.ts';
import { textureSeed } from '#lib/agent/jobs/types/asset-generation/recipes.ts';
import { errMessage } from '#lib/utils/error.ts';

/** What one set came to. */
export interface TransitionOutcome {
	id: string;
	status: 'done' | 'skipped' | 'unresolved' | 'failed';
	attempts: number;
	durationMs: number;
	/** Why it failed, or what the judge last said against it. */
	reason?: string;
	/** The edge, when the judge's no made the run revise it. */
	edge?: TransitionEdge;
	/** The sheet and its JSON map, when they were written. */
	files?: string[];
}

export interface TransitionDeps {
	spec: AssetSpec;
	/** Every set and texture in a run is drawn at one size. */
	tileSize: number;
	signal: AbortSignal;
	exists: (rel: string) => Promise<boolean>;
	writeBytes: (rel: string, bytes: Uint8Array) => Promise<void>;
	writeText: (rel: string, text: string) => Promise<void>;
	render: (
		view: TransitionView,
		a: TextureRecipe,
		other: TextureRecipe | null,
		edge: TransitionEdge,
		seeds: { a: number; other: number }
	) => Promise<Uint8Array>;
	preview: (view: TransitionView, sheet: Uint8Array) => Promise<Uint8Array>;
	/** Null when no judge will look: off, or the model can't see. */
	judge: ((t: TransitionEntry, preview: Uint8Array) => Promise<Verdict | null>) | null;
	revise: (
		t: TransitionEntry,
		reason: string,
		preview: Uint8Array
	) => Promise<TransitionEdge | null>;
}

interface Verdict {
	ok: boolean;
	reason: string;
}

/** The set's materials as the spec has them, or why it can't be drawn. */
function materials(
	t: TransitionEntry,
	spec: AssetSpec
): { a: AssetEntry; other: AssetEntry | null } | string {
	const find = (id: string | undefined) => (id ? spec.entries.find((e) => e.id === id) : undefined);
	const a = find(t.a);
	const other = find(t.view === 'top' ? t.b : t.cap) ?? null;
	for (const [id, e] of [
		[t.a, a],
		[t.view === 'top' ? t.b : t.cap, other]
	] as const) {
		if (id && !e?.recipe) return `The set needs ${id}'s recipe, and it has none.`;
	}
	return { a: a!, other };
}

/**
 * Draw one set, write its sheet and JSON map, and show the judge the set
 * laid out as a map. One no gets one revised edge; a second keeps the sheet
 * and marks it rejected.
 */
export async function runTransition(
	t: TransitionEntry,
	deps: TransitionDeps
): Promise<TransitionOutcome> {
	const started = Date.now();
	const done = (o: Omit<TransitionOutcome, 'id' | 'durationMs'>): TransitionOutcome => ({
		id: t.id,
		durationMs: Date.now() - started,
		...o
	});
	if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	if (escapesWorkdir(t.out)) {
		return done({
			status: 'failed',
			attempts: 0,
			reason: `${t.out} escapes the working directory.`
		});
	}
	if (await deps.exists(t.out)) return done({ status: 'skipped', attempts: 0 });
	const m = materials(t, deps.spec);
	if (typeof m === 'string') return done({ status: 'failed', attempts: 0, reason: m });

	const [sheetPath, jsonPath] = transitionFiles(t.out);
	// Each material's own seed, as its texture was drawn: the set's plain
	// tiles are then that texture's tiles.
	const seeds = { a: textureSeed(m.a), other: m.other ? textureSeed(m.other) : 0 };
	const draw = async (edge: TransitionEdge) => {
		const sheet = await deps.render(t.view, m.a.recipe!, m.other?.recipe ?? null, edge, seeds);
		await deps.writeBytes(sheetPath, sheet);
		return sheet;
	};
	const map = transitionMap(t.view, deps.tileSize, t.a, t.view === 'top' ? t.b : t.cap);
	const files = [sheetPath, jsonPath];

	try {
		const sheet = await draw(t.edge ?? {});
		await deps.writeText(jsonPath, `${JSON.stringify(map, null, '\t')}\n`);
		return done({ ...(await judgeAndRevise(t, sheet, draw, deps)), files });
	} catch (e) {
		if (isCancellation(e)) throw e;
		return done({ status: 'failed', attempts: 1, reason: errMessage(e) });
	}
}

/**
 * The judge's look at a drawn set, and on a no one revised edge, redrawn.
 * Without a judge, it passes as drawn.
 */
async function judgeAndRevise(
	t: TransitionEntry,
	first: Uint8Array,
	draw: (edge: TransitionEdge) => Promise<Uint8Array>,
	deps: TransitionDeps
): Promise<Omit<TransitionOutcome, 'id' | 'durationMs'>> {
	let edge = t.edge ?? {};
	let revised: TransitionEdge | undefined;
	let sheet = first;
	for (let attempt = 1; ; attempt++) {
		const base = { attempts: attempt, ...(revised ? { edge: revised } : {}) };
		if (!deps.judge) return { status: 'done', ...base };
		const shown = await deps.preview(t.view, sheet);
		const verdict = await deps.judge(t, shown);
		if (!verdict || verdict.ok) return { status: 'done', ...base };
		const next = attempt === 1 ? await deps.revise({ ...t, edge }, verdict.reason, shown) : null;
		if (!next) return { status: 'unresolved', reason: verdict.reason, ...base };
		edge = revised = next;
		sheet = await draw(edge);
	}
}

/**
 * The spec after a run drew its sets: a revised edge kept, a set the judge
 * never passed marked `rejected`, one that passed unmarked. Null when
 * nothing changed.
 */
export function applyTransitions(spec: AssetSpec, outcomes: TransitionOutcome[]): AssetSpec | null {
	if (!spec.transitions?.length || outcomes.length === 0) return null;
	const byId = new Map(outcomes.map((o) => [o.id, o]));
	let changed = false;
	const transitions = spec.transitions.map((t): TransitionEntry => {
		const o = byId.get(t.id);
		if (!o) return t;
		let next = o.edge ? { ...t, edge: o.edge } : t;
		if (o.status === 'unresolved')
			next = { ...next, rejected: o.reason ?? 'rejected by the check' };
		if (o.status === 'done' && next.rejected !== undefined) {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { rejected, ...rest } = next;
			next = rest;
		}
		if (JSON.stringify(next) !== JSON.stringify(t)) changed = true;
		return next;
	});
	return changed ? { ...spec, transitions } : null;
}
