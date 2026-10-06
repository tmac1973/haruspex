/**
 * The generation loop: walk the spec, make each asset, write it out.
 *
 * Every entry is independent. One missing model or one prompt the backend
 * refuses must not cost the other ninety-nine — so a failure is recorded
 * against that entry and the loop carries on, and the run ends with a report
 * rather than a stack trace. The only thing that stops the loop is the user.
 */

import { checkImage, effectiveProfile, normalizeImage } from '$lib/assets/normalize';
import type { AssetEntry, AssetSpec, NormalizeProfile } from '$lib/assets/spec/types';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { ImageBackendCapabilities, ImageRequest, ImageResult } from '$lib/image/types';
import { NOT_SEAMLESS, buildEntryRequest, checkProfile } from './request';
import {
	amendForRetry,
	betterReport,
	judgeUnavailable,
	maybeJudge,
	rejectionReason,
	retrySeed,
	type JudgeDeps
} from './gate';
import { escapesWorkdir, isCancellation, isTransient, keepBest, reasonOf } from './guards';
import { planSheets, type SheetPlan } from './sheets';
import { runSheet as runSheetLoop } from './sheetLoop';
import type { EntryOutcome, SheetOutcome } from './types';
import type { TextureRecipe } from '$lib/ipc/gen/TextureRecipe';
import { runCodeTexture } from './codeTexture';

export { escapesWorkdir } from './guards';

export interface GenerateDeps {
	caps: ImageBackendCapabilities;
	concurrency: number;
	maxEdge: number;
	/** Generations allowed per entry before it is recorded unresolved. */
	maxAttempts: number;
	judge: JudgeDeps;
	signal: AbortSignal;
	generate: (req: ImageRequest, opts: { signal: AbortSignal }) => Promise<ImageResult>;
	exists: (relPath: string) => Promise<boolean>;
	writeBytes: (relPath: string, bytes: Uint8Array) => Promise<void>;
	/** `n/total — <id>`, for the stage's streaming line. */
	progress: (done: number, total: number, id: string) => void;
	/** Every generation of a sheet, as it happens, for the report. */
	onSheet?: (outcome: SheetOutcome) => void;
	/**
	 * Sheets already generated, by sheet id — the style anchor, which IS the
	 * first sheet. Used as that sheet's first round instead of a new request,
	 * so the assets cut from it are the ones the user approved.
	 */
	pregenerated?: Map<string, ImageResult>;
	/**
	 * Textures drawn by code from their recipe. Absent: textures go to the
	 * image model like everything else.
	 */
	codeTextures?: CodeTextureDeps;
}

export interface CodeTextureDeps {
	/** Tiles per texture. */
	variants: number;
	/** PNG bytes for each variant, base first. */
	render: (recipe: TextureRecipe, seed: number, variants: number) => Promise<Uint8Array[]>;
	/** A new recipe after the judge's no, with what it draws, or null. */
	revise: (
		entry: AssetEntry,
		reason: string
	) => Promise<{ recipe: TextureRecipe; drawn: string } | null>;
	/** Why an entry has no recipe, when the recipe stage gave up on it. */
	recipeFailures: Map<string, string>;
}

/** What one entry produced, plus the gate's verdict on it. */
export interface EntryResult {
	outcome: EntryOutcome;
	/** The best report seen across attempts. Null when nothing was generated. */
	report: CheckReport | null;
}

/**
 * Resolve each kind's profile once, through the same Rust code that will
 * normalize the result.
 *
 * Fetched rather than re-derived in TypeScript: the per-kind branch — a
 * texture is not cropped, not outlined, and keeps its own background — must
 * be decided in exactly one place, or the request and the normalization come
 * to disagree about what a texture is.
 */
async function profilesByKind(
	spec: AssetSpec,
	base: NormalizeProfile
): Promise<Map<AssetEntry['kind'], NormalizeProfile>> {
	const kinds = [...new Set(spec.entries.map((e) => e.kind))];
	const resolved = await Promise.all(kinds.map((k) => effectiveProfile(base, k)));
	return new Map(kinds.map((k, i) => [k, resolved[i]]));
}

/**
 * Run `worker` over `items` with at most `limit` in flight, in index order.
 *
 * Results are applied by index by the caller, so completion order never
 * reaches the report — two runs of the same spec produce the same document.
 */
async function pool(items: number[], limit: number, worker: (i: number) => Promise<void>) {
	let next = 0;
	const lanes = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: lanes }, async () => {
			for (;;) {
				const k = next++;
				if (k >= items.length) return;
				await worker(items[k]);
			}
		})
	);
}

export async function generateEntries(spec: AssetSpec, deps: GenerateDeps): Promise<EntryResult[]> {
	// On a backend that gives alpha, nothing is forced into the anchor's
	// colours: each sheet takes its own palette (`sheetLoop.ts`), and an image
	// made alone — a texture — takes its own, extracted by normalization. A
	// shared palette is only imposed on the older one-image-per-entry path,
	// where it is what holds a set of separately drawn images together.
	const base = deps.caps.transparency ? { ...spec.normalize, palette: [] } : spec.normalize;
	const profiles = await profilesByKind(spec, base);
	const results: (EntryResult | null)[] = spec.entries.map(() => null);
	const transient: number[] = [];
	let done = 0;

	function abortIfCancelled() {
		if (deps.signal.aborted) throw new DOMException('Aborted', 'AbortError');
	}

	async function runOne(index: number, retry: boolean): Promise<void> {
		abortIfCancelled();
		const entry = spec.entries[index];
		const started = Date.now();
		const finish = (
			outcome: Omit<EntryOutcome, 'id' | 'durationMs'>,
			report: CheckReport | null
		) => {
			results[index] = {
				outcome: { id: entry.id, durationMs: Date.now() - started, ...outcome },
				report
			};
			done++;
			deps.progress(done, spec.entries.length, entry.id);
		};

		// Checked again at write time rather than trusted from validation: the
		// spec may have been edited, or derived and rewritten, since.
		if (escapesWorkdir(entry.out)) {
			finish(
				{
					status: 'failed',
					attempts: 0,
					seed: null,
					degraded: [],
					reason: `The output path ${entry.out} escapes the working directory.`
				},
				null
			);
			return;
		}

		// Deleting ten files and re-running regenerates exactly those ten.
		if (!retry && (await deps.exists(entry.out))) {
			finish({ status: 'skipped', attempts: 0, seed: null, degraded: [] }, null);
			return;
		}

		const { request, degraded } = buildEntryRequest(
			entry,
			spec,
			profiles.get(entry.kind) ?? spec.normalize,
			deps.caps,
			{ maxEdge: deps.maxEdge }
		);
		const profile = checkProfile(profiles.get(entry.kind) ?? spec.normalize, request);
		const normalizeOnly = profiles.get(entry.kind) ?? spec.normalize;

		let prompt = request.prompt;
		let negativePrompt = request.negativePrompt ?? '';
		let seed = request.seed;
		let best: CheckReport | null = null;
		/** The image behind `best`, written if every attempt is rejected. */
		let bestBytes: Uint8Array | undefined;
		let lastReason = '';
		let lastSeed: number | null = null;

		for (let attempt = 1; ; attempt++) {
			abortIfCancelled();
			let result: ImageResult;
			try {
				result = await deps.generate(
					{ ...request, prompt, negativePrompt, seed },
					{
						signal: deps.signal
					}
				);
			} catch (e) {
				if (isCancellation(e)) throw e;
				if (!retry && attempt === 1 && isTransient(e)) {
					// Re-queued once at the end of the run, in case the backend
					// came back. Not counted as done — it has not finished.
					transient.push(index);
					return;
				}
				finish(
					{ status: 'failed', attempts: attempt, seed: lastSeed, degraded, reason: reasonOf(e) },
					best
				);
				return;
			}
			lastSeed = result.meta.seed;
			// The backend drew the texture but could not make it tile. Judged
			// without the seam gate — retrying would hit the same wall and lose
			// the texture — and reported as not seamless.
			const untiled = request.seamless && result.meta.seamFailed;
			if (untiled && !degraded.includes(NOT_SEAMLESS)) degraded.push(NOT_SEAMLESS);
			const attemptProfile = untiled ? normalizeOnly : profile;

			let report: CheckReport;
			let bytes: Uint8Array;
			try {
				const normalized = await normalizeImage(result.images[0].bytes, attemptProfile, entry.kind);
				bytes = new Uint8Array(normalized.bytes);
				report = await checkImage(normalized.stats, attemptProfile, entry.kind);
			} catch (e) {
				if (isCancellation(e)) throw e;
				// Normalization refuses an image with nothing left in it, which
				// is a rejection like any other — retried, not fatal.
				lastReason = reasonOf(e);
				if (attempt >= deps.maxAttempts) {
					const kept = await keepBest(deps.writeBytes, entry.out, bestBytes);
					finish(
						{
							status: 'unresolved',
							attempts: attempt,
							seed: lastSeed,
							degraded,
							reason: lastReason,
							...(kept ? { kept } : {})
						},
						best
					);
					return;
				}
				seed = retrySeed();
				continue;
			}

			// The judge costs a turn, so it only sees images that already
			// passed the free checks — there is nothing to ask about a blank.
			const judged = report.passed ? await maybeJudge(entry, bytes, deps.judge) : { verdict: null };
			const verdict = judged.verdict;
			if (judged.unavailable) degraded.push(judgeUnavailable(judged.unavailable));
			if (report.passed && (!verdict || verdict.ok)) {
				try {
					await deps.writeBytes(entry.out, bytes);
				} catch (e) {
					if (isCancellation(e)) throw e;
					finish(
						{
							status: 'failed',
							attempts: attempt,
							seed: lastSeed,
							degraded,
							reason: reasonOf(e)
						},
						report
					);
					return;
				}
				finish({ status: 'done', attempts: attempt, seed: lastSeed, degraded }, report);
				return;
			}

			const nextBest = betterReport(best, report);
			if (nextBest === report) bestBytes = bytes;
			best = nextBest;
			lastReason = rejectionReason(report, verdict);
			if (attempt >= deps.maxAttempts) {
				// The best attempt is written, so the code has a file to load,
				// and the spec marks it rejected: a re-run skips a file on disk,
				// so it is Review assets that sends it back, not the next run.
				const kept = await keepBest(deps.writeBytes, entry.out, bestBytes);
				finish(
					{
						status: 'unresolved',
						attempts: attempt,
						seed: lastSeed,
						degraded,
						reason: lastReason,
						...(kept ? { kept } : {})
					},
					best
				);
				return;
			}

			// Amended from the ORIGINAL request each time, not from the last
			// amendment: three rounds of compounding suffixes produce a prompt
			// that is mostly corrections.
			const amended = amendForRetry(
				request.prompt,
				request.negativePrompt ?? '',
				report.failed,
				spec.style.prompt
			);
			prompt = amended.prompt;
			negativePrompt = amended.negativePrompt;
			// A new seed even for an entry that pinned one: a pinned seed that
			// fails every check retries identically until the budget runs out.
			seed = retrySeed();
		}
	}

	/** Record one entry's result, as `runOne`'s `finish` does. */
	function record(
		index: number,
		started: number,
		outcome: Omit<EntryOutcome, 'id' | 'durationMs'>,
		report: CheckReport | null
	) {
		const entry = spec.entries[index];
		results[index] = {
			outcome: { id: entry.id, durationMs: Date.now() - started, ...outcome },
			report
		};
		done++;
		deps.progress(done, spec.entries.length, entry.id);
	}

	const transientSheets: SheetPlan[] = [];

	async function runSheet(plan: SheetPlan, retry: boolean): Promise<void> {
		abortIfCancelled();
		await runSheetLoop(plan, {
			spec,
			deps,
			profile: profiles.get(plan.kind) ?? spec.normalize,
			retry,
			record,
			requeue: (p) => transientSheets.push(p)
		});
	}

	const sheets = deps.caps.transparency ? planSheets(spec.entries) : [];
	const onSheets = new Set(sheets.flatMap((p) => p.entries));
	const singles = spec.entries.map((_, i) => i).filter((i) => !onSheets.has(spec.entries[i]));
	const code = deps.codeTextures;
	await pool(singles, deps.concurrency, (i) =>
		code && spec.entries[i].kind === 'texture'
			? runCodeTexture(i, { spec, deps, code, record })
			: runOne(i, false)
	);
	await pool(
		sheets.map((_, k) => k),
		deps.concurrency,
		(k) => runSheet(sheets[k], false)
	);

	if (transient.length > 0 || transientSheets.length > 0) {
		abortIfCancelled();
		const queued = [...transient];
		transient.length = 0;
		await pool(queued, deps.concurrency, (i) => runOne(i, true));
		const queuedSheets = [...transientSheets];
		transientSheets.length = 0;
		await pool(
			queuedSheets.map((_, k) => k),
			deps.concurrency,
			(k) => runSheet(queuedSheets[k], true)
		);
	}

	return results.map((r, i) => {
		if (r) return r;
		// Only reachable if a lane threw between the transient push and the
		// re-queue — recorded rather than dropped, so the report's counts add up.
		return {
			outcome: {
				id: spec.entries[i].id,
				status: 'failed' as const,
				attempts: 1,
				seed: null,
				durationMs: 0,
				degraded: [],
				reason: 'The backend never returned an image for this entry.'
			},
			report: null
		};
	});
}
