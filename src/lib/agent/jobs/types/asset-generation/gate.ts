/**
 * The quality gate: nothing is accepted because it came back.
 *
 * This phase exists because of a bug found the hard way elsewhere in this
 * codebase: a stage that trusts its producer reports success for work that
 * never happened. A blank generation is still a PNG, and a hundred of them on
 * disk look exactly like a hundred assets until someone opens one.
 *
 * Two halves. The mechanical checks are deterministic, free, and run on every
 * asset. The vision judge is optional, costs a turn, and only runs when the
 * job's model can actually see — never failing an entry for a capability the
 * user does not have.
 */

import type { CheckName } from '$lib/ipc/gen/CheckName';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { AssetEntry } from '$lib/assets/spec/types';
import type { AssetJudgement } from './tools';

/**
 * How to amend the next attempt for each failure.
 *
 * A table rather than a judgement call: the amendment has to be reproducible,
 * and "ask the model what went wrong" is how a retry loop becomes a second
 * source of randomness on top of the one it is trying to correct.
 *
 * Direction matters, and getting it wrong is worse than having no amendment.
 * These were originally all negatives, which inverted two of the four: a
 * fully-opaque result was retried with "flat background" in the NEGATIVE
 * prompt, telling the model to avoid the very thing that was missing, and an
 * off-style result was retried with "limited palette" in the negative. Every
 * retry made its own failure more likely, and the first real run of this
 * pipeline lost all four assets to it with three identical attempts each.
 *
 * So each entry says explicitly which prompt it belongs in. What we want goes
 * in `positive`; what we want less of goes in `negative`.
 */
export interface RetryAmendment {
	positive?: string;
	negative?: string;
}

export const RETRY_AMENDMENTS: Record<CheckName, RetryAmendment> = {
	// Nothing opaque: the subject is missing, so say what not to produce.
	alpha_low: { negative: 'blank, empty, transparent' },
	// Fully opaque: there was no background to remove. Ask for the empty
	// margin directly, and push away from the full-frame composition SD1.5
	// falls into.
	alpha_high: {
		positive: 'tiny object alone in the centre, wide empty margins, plain unbroken backdrop',
		negative: 'full frame, close-up, zoomed in, filling the frame, cropped, scenery, still life'
	},
	// Flat mush: say what not to produce.
	entropy: { negative: 'featureless, flat, low detail, plain, empty' },
	// Off-style: the fix is to say the style again, not to say what to avoid.
	palette_distance: { positive: 'limited palette, flat blocks of colour' },
	// A seam left after tiling is nearly always a border the model drew round
	// the texture that the repaint did not cover. Ming takes no negative
	// prompt, so there the retry's new seed is what fixes it; SD reads this.
	seam: { negative: 'border, frame, vignette, darker edges' }
};

/** In plain words, for the report. */
export const CHECK_LABELS: Record<CheckName, string> = {
	alpha_low: 'almost nothing opaque — the generation came back blank',
	alpha_high: 'fully opaque — the background was never removed',
	entropy: 'too little detail — flat mush',
	palette_distance: 'off-style — too far from its palette',
	seam: 'a visible seam when tiled'
};

export function describeFailures(failed: CheckName[]): string {
	return failed.map((f) => CHECK_LABELS[f]).join('; ');
}

/**
 * The prompt amendments for one round of failures.
 *
 * Returns both halves. `palette_distance` also re-appends the style prompt,
 * because being off-style is the one failure whose fix is to say the style
 * again rather than to say what to avoid.
 */
export function amendForRetry(
	basePrompt: string,
	baseNegative: string,
	failed: CheckName[],
	stylePrompt: string
): { prompt: string; negativePrompt: string } {
	const join = (parts: Array<string | undefined>) =>
		parts
			.map((s) => (s ?? '').trim())
			.filter((s) => s.length > 0)
			.join(', ');

	const positives = failed.map((f) => RETRY_AMENDMENTS[f]?.positive);
	if (failed.includes('palette_distance')) positives.push(stylePrompt);

	return {
		prompt: join([basePrompt, ...positives]),
		negativePrompt: join([baseNegative, ...failed.map((f) => RETRY_AMENDMENTS[f]?.negative)])
	};
}

/**
 * Which of two reports to keep when an entry never passes.
 *
 * Fewest failures wins, ties go to the lower palette distance. The point is
 * that the report can say how close the run got: "failed entropy by 0.02" and
 * "came back blank four times" are different problems, and a user who cannot
 * tell them apart cannot fix either.
 */
export function betterReport(a: CheckReport | null, b: CheckReport): CheckReport {
	if (!a) return b;
	if (b.failed.length < a.failed.length) return b;
	if (b.failed.length === a.failed.length && b.stats.palette_distance < a.stats.palette_distance) {
		return b;
	}
	return a;
}

/** Why an attempt was rejected, in one line for the report. */
export function rejectionReason(report: CheckReport, judge: AssetJudgement | null): string {
	if (judge && !judge.ok) return judge.reason;
	return describeFailures(report.failed);
}

/**
 * A new seed for a retry.
 *
 * Even for an entry that pinned one. A pinned seed that fails every check
 * would otherwise retry identically until the budget ran out, which is the
 * most expensive possible way to produce the same bad image four times.
 */
export function retrySeed(): number {
	return Math.floor(Math.random() * 2_147_483_647);
}

export interface JudgeDeps {
	/** False when the job's model cannot see. The judge is then skipped. */
	visionSupported: boolean;
	enabled: boolean;
	judge: (entry: AssetEntry, image: Uint8Array) => Promise<AssetJudgement | null>;
}

/** What came of asking the judge. */
export interface JudgeOutcome {
	/** Null when the judge did not run or could not: "no opinion", never approval. */
	verdict: AssetJudgement | null;
	/** Why it could not, when it was asked and failed. */
	unavailable?: string;
}

/**
 * Run the judge if it is wanted — or `force`d — and possible.
 *
 * A judge that fails is no opinion, not a failed asset. The judge is the
 * job's chat model, and that model being down (still loading, or pushed out of
 * memory by the image backend) once cost a run two good sprites that had
 * already passed every mechanical check. The caller records `unavailable` so
 * the report can say which assets nobody looked at.
 */
export async function maybeJudge(
	entry: AssetEntry,
	image: Uint8Array,
	deps: JudgeDeps,
	force = false
): Promise<JudgeOutcome> {
	if (!deps.visionSupported || (!deps.enabled && !force)) return { verdict: null };
	try {
		return { verdict: await deps.judge(entry, image) };
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		return { verdict: null, unavailable: e instanceof Error ? e.message : String(e) };
	}
}

/** The degradation line for an asset the judge was meant to see and could not. */
export function judgeUnavailable(reason: string): string {
	return `not checked by the judge — ${reason.replace(/[.\s]+$/, '')}`;
}
