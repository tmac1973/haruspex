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
import { ImageBackendError } from '$lib/image/types';
import type { ImageBackendCapabilities, ImageRequest, ImageResult } from '$lib/image/types';
import { buildEntryRequest } from './request';
import {
	amendForRetry,
	betterReport,
	maybeJudge,
	rejectionReason,
	retrySeed,
	type JudgeDeps
} from './gate';
import type { EntryOutcome } from './types';

/** Absolute, drive-lettered, or climbing out of the working directory. */
export function escapesWorkdir(p: string): boolean {
	const n = p.replace(/\\/g, '/');
	if (n.startsWith('/')) return true;
	if (/^[a-zA-Z]:/.test(n)) return true;
	return n.split('/').includes('..');
}

export interface GenerateDeps {
	caps: ImageBackendCapabilities;
	/** The committed reference every entry is conditioned on. */
	anchor: Uint8Array | null;
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
}

/** What one entry produced, plus the gate's verdict on it. */
export interface EntryResult {
	outcome: EntryOutcome;
	/** The best report seen across attempts. Null when nothing was generated. */
	report: CheckReport | null;
}

/** Transient means the backend may come back; permanent means retrying is theatre. */
function isTransient(e: unknown): boolean {
	return e instanceof ImageBackendError && (e.kind === 'unreachable' || e.kind === 'timeout');
}

function isCancellation(e: unknown): boolean {
	if (e instanceof ImageBackendError) return e.kind === 'cancelled';
	return e instanceof DOMException && e.name === 'AbortError';
}

function reasonOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
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
	const profiles = await profilesByKind(spec, spec.normalize);
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

		const profile = profiles.get(entry.kind) ?? spec.normalize;
		const { request, degraded } = buildEntryRequest(entry, spec, profile, deps.caps, {
			anchor: deps.anchor,
			maxEdge: deps.maxEdge
		});

		let prompt = request.prompt;
		let negativePrompt = request.negativePrompt ?? '';
		let seed = request.seed;
		let best: CheckReport | null = null;
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

			let report: CheckReport;
			let bytes: Uint8Array;
			try {
				const normalized = await normalizeImage(result.images[0].bytes, profile, entry.kind);
				bytes = new Uint8Array(normalized.bytes);
				report = await checkImage(normalized.stats, profile, entry.kind);
			} catch (e) {
				if (isCancellation(e)) throw e;
				// Normalization refuses an image with nothing left in it, which
				// is a rejection like any other — retried, not fatal.
				lastReason = reasonOf(e);
				if (attempt >= deps.maxAttempts) {
					finish(
						{
							status: 'unresolved',
							attempts: attempt,
							seed: lastSeed,
							degraded,
							reason: lastReason
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
			const verdict = report.passed ? await maybeJudge(entry, bytes, deps.judge) : null;
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

			best = betterReport(best, report);
			lastReason = rejectionReason(report, verdict);
			if (attempt >= deps.maxAttempts) {
				// Nothing is written. A half-good PNG on disk would be skipped
				// by the next run's skip-existing rule and never retried.
				finish(
					{
						status: 'unresolved',
						attempts: attempt,
						seed: lastSeed,
						degraded,
						reason: lastReason
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

	const all = spec.entries.map((_, i) => i);
	await pool(all, deps.concurrency, (i) => runOne(i, false));

	if (transient.length > 0) {
		abortIfCancelled();
		const queued = [...transient];
		transient.length = 0;
		await pool(queued, deps.concurrency, (i) => runOne(i, true));
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
