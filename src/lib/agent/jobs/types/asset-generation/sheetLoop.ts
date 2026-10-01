/**
 * One sheet, from request to written files.
 *
 * Generate, cut, match each piece to its subject, check each, and generate
 * again with only the subjects that failed. The failed cells go round again
 * TOGETHER, as a smaller sheet, not one at a time: the subjects that came out
 * well carry the sheet's look, and a retry sheet stays closer to it than
 * singles would. A sheet of one is a single centred sprite (`sheetPrompt`).
 * Each entry keeps its own attempt budget, exactly as on the single-image
 * path in `generate.ts`, which owns the bookkeeping this module reports into.
 */

import { checkImage, normalizeImage, splitSheet } from '$lib/assets/normalize';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { ImageResult } from '$lib/image/types';
import { betterReport, judgeUnavailable, maybeJudge, rejectionReason } from './gate';
import type { GenerateDeps } from './generate';
import { escapesWorkdir, isCancellation, isTransient, reasonOf } from './guards';
import { assignCells, sheetRequest, type CellResult, type SheetPlan } from './sheets';
import type { EntryOutcome, SheetOutcome } from './types';

type Outcome = Omit<EntryOutcome, 'id' | 'durationMs'>;

export interface SheetLoopContext {
	spec: AssetSpec;
	deps: GenerateDeps;
	/** The resolved profile for the sheet's kind. */
	profile: NormalizeProfile;
	/** True on the end-of-run pass for a sheet the backend dropped once. */
	retry: boolean;
	/** Report one entry's result to the run's bookkeeping. */
	record: (index: number, started: number, outcome: Outcome, report: CheckReport | null) => void;
	/** Hand a sheet back to be tried once more at the end of the run. */
	requeue: (plan: SheetPlan) => void;
}

/** Per-entry state across a sheet's rounds. */
interface Tally {
	attempts: Map<number, number>;
	best: Map<number, CheckReport | null>;
}

/**
 * The entries of a plan that need generating. The rest are recorded here:
 * an output path that escapes the working directory fails, and one already on
 * disk is skipped — deleting ten files and re-running regenerates those ten.
 */
async function admit(plan: SheetPlan, ctx: SheetLoopContext, started: number): Promise<number[]> {
	const pending: number[] = [];
	for (const e of plan.entries) {
		const index = ctx.spec.entries.indexOf(e);
		if (escapesWorkdir(e.out)) {
			const reason = `The output path ${e.out} escapes the working directory.`;
			ctx.record(
				index,
				started,
				{ status: 'failed', attempts: 0, seed: null, degraded: [], reason },
				null
			);
		} else if (!ctx.retry && (await ctx.deps.exists(e.out))) {
			ctx.record(
				index,
				started,
				{ status: 'skipped', attempts: 0, seed: null, degraded: [] },
				null
			);
		} else {
			pending.push(index);
		}
	}
	return pending;
}

/** What one cell came to: written, or a reason to try again. */
type CellVerdict =
	| { done: true; report: CheckReport; degraded: string[] }
	| { done: false; reason: string; report: CheckReport | null; rejected: boolean };

/**
 * Normalize, check and (maybe) judge one cut piece, and write it if it passes.
 *
 * A suspect piece — found by position alone because the layout did not come
 * out as asked, or sharing its cell — is always shown to the judge when the
 * model can see, whatever the judge setting: position alone cannot tell a
 * sword drawn where the potion should be from the potion.
 */
async function processCell(
	entry: AssetEntry,
	cell: CellResult,
	ctx: SheetLoopContext
): Promise<CellVerdict> {
	if (cell.status !== 'ok' || !cell.piece) {
		const reason =
			cell.status === 'missing'
				? 'Missing from its sheet — the model drew nothing in its place.'
				: 'Drawn touching a neighbour on its sheet, so it could not be cut out.';
		return { done: false, reason, report: null, rejected: false };
	}
	let bytes: Uint8Array;
	let report: CheckReport;
	try {
		const normalized = await normalizeImage(
			new Uint8Array(cell.piece.bytes),
			ctx.profile,
			entry.kind
		);
		bytes = new Uint8Array(normalized.bytes);
		report = await checkImage(normalized.stats, ctx.profile, entry.kind);
	} catch (e) {
		if (isCancellation(e)) throw e;
		return { done: false, reason: reasonOf(e), report: null, rejected: true };
	}
	// A suspect piece — found by position alone because the layout did not
	// come out as asked, or sharing its cell — is shown to the judge whenever
	// the model can see, whatever the judge setting.
	const judged = report.passed
		? await maybeJudge(entry, bytes, ctx.deps.judge, cell.suspect)
		: { verdict: null };
	const verdict = judged.verdict;
	if (!report.passed || (verdict && !verdict.ok)) {
		return { done: false, reason: rejectionReason(report, verdict), report, rejected: true };
	}
	const degraded = judged.unavailable ? [judgeUnavailable(judged.unavailable)] : [];
	await ctx.deps.writeBytes(entry.out, bytes);
	return { done: true, report, degraded };
}

/** Generate one round; null when it failed or was handed back. */
async function generateRound(
	plan: SheetPlan,
	pending: number[],
	round: number,
	ctx: SheetLoopContext,
	tally: Tally,
	started: number
): Promise<ImageResult | null> {
	const asked = pending.map((i) => ctx.spec.entries[i]);
	// The anchor sheet was generated (and approved) in the Anchor stage; its
	// first round is that image, as long as every one of its subjects is still
	// wanted — otherwise the cut would not line up with what is asked for.
	const pre = round === 1 ? ctx.deps.pregenerated?.get(plan.id) : undefined;
	if (pre && asked.length === plan.entries.length) return pre;
	try {
		return await ctx.deps.generate(sheetRequest(asked, ctx.spec), { signal: ctx.deps.signal });
	} catch (e) {
		if (isCancellation(e)) throw e;
		if (!ctx.retry && round === 1 && isTransient(e)) {
			// Tried once more at the end of the run, like a single image.
			ctx.requeue({ ...plan, entries: asked });
			return null;
		}
		for (const i of pending) {
			const attempts = (tally.attempts.get(i) ?? 0) + 1;
			const outcome: Outcome = {
				status: 'failed',
				attempts,
				seed: null,
				degraded: [],
				reason: reasonOf(e)
			};
			ctx.record(i, started, outcome, tally.best.get(i) ?? null);
		}
		return null;
	}
}

/**
 * Process one cell and record what came of it. Returns true when the entry
 * should go round again on the next, smaller sheet.
 */
async function settleCell(
	i: number,
	cell: CellResult,
	round: { ctx: SheetLoopContext; tally: Tally; sheet: SheetOutcome; seed: number; started: number }
): Promise<boolean> {
	const { ctx, tally, sheet, seed, started } = round;
	const attempts = tally.attempts.get(i) ?? 0;
	let verdict: CellVerdict;
	try {
		verdict = await processCell(ctx.spec.entries[i], cell, ctx);
	} catch (e) {
		if (isCancellation(e)) throw e;
		// The write failed. Not retried: the next attempt would fail the same way.
		const outcome: Outcome = {
			status: 'failed',
			attempts,
			seed,
			degraded: [],
			reason: reasonOf(e)
		};
		ctx.record(i, started, outcome, null);
		return false;
	}
	if (verdict.done) {
		const outcome: Outcome = { status: 'done', attempts, seed, degraded: verdict.degraded };
		ctx.record(i, started, outcome, verdict.report);
		return false;
	}
	if (verdict.rejected) sheet.rejected++;
	if (verdict.report) tally.best.set(i, betterReport(tally.best.get(i) ?? null, verdict.report));
	if (attempts < ctx.deps.maxAttempts) return true;
	const outcome: Outcome = {
		status: 'unresolved',
		attempts,
		seed,
		degraded: [],
		reason: verdict.reason
	};
	ctx.record(i, started, outcome, tally.best.get(i) ?? null);
	return false;
}

export async function runSheet(plan: SheetPlan, ctx: SheetLoopContext): Promise<void> {
	const started = Date.now();
	const tally: Tally = { attempts: new Map(), best: new Map() };
	let pending = await admit(plan, ctx, started);

	for (let round = 1; pending.length > 0; round++) {
		if (ctx.deps.signal.aborted) throw new DOMException('Aborted', 'AbortError');
		const result = await generateRound(plan, pending, round, ctx, tally, started);
		if (!result) return;
		for (const i of pending) tally.attempts.set(i, (tally.attempts.get(i) ?? 0) + 1);
		const seed = result.meta.seed;

		const split = await splitSheet(result.images[0].bytes, {
			alphaThreshold: ctx.profile.alpha_threshold ?? undefined,
			background: ctx.profile.background
		});
		const cells = assignCells(split.pieces, pending.length);
		const sheet: SheetOutcome = {
			id: plan.id,
			round,
			subjects: pending.map((i) => ctx.spec.entries[i].id),
			exact: cells.every((c) => c.status === 'ok' && !c.suspect),
			keyed: split.keyed,
			missing: cells.filter((c) => c.status === 'missing').length,
			merged: cells.filter((c) => c.status === 'merge').length,
			rejected: 0,
			seed
		};

		const next: number[] = [];
		for (const [k, i] of pending.entries()) {
			if (await settleCell(i, cells[k], { ctx, tally, sheet, seed, started })) next.push(i);
		}

		ctx.deps.onSheet?.(sheet);
		pending = next;
	}
}
