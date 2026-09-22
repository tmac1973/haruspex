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
 * What to append to the next attempt's negative prompt for each failure.
 *
 * A table rather than a judgement call: the amendment has to be reproducible,
 * and "ask the model what went wrong" is how a retry loop becomes a second
 * source of randomness on top of the one it is trying to correct.
 */
export const RETRY_AMENDMENTS: Record<CheckName, string> = {
	alpha_low: 'blank, empty, transparent',
	alpha_high: 'flat background, no subject isolation',
	entropy: 'featureless, flat, low detail',
	palette_distance: 'limited palette'
};

/** In plain words, for the report. */
export const CHECK_LABELS: Record<CheckName, string> = {
	alpha_low: 'almost nothing opaque — the generation came back blank',
	alpha_high: 'fully opaque — the background was never removed',
	entropy: 'too little detail — flat mush',
	palette_distance: 'off-style — too far from the anchor palette'
};

export function describeFailures(failed: CheckName[]): string {
	return failed.map((f) => CHECK_LABELS[f]).join('; ');
}

/**
 * The negative-prompt amendment for one round of failures.
 *
 * `palette_distance` also re-appends the style prompt, because being off-style
 * is the one failure whose fix is to say the style again rather than to say
 * what to avoid.
 */
export function amendNegative(
	base: string,
	failed: CheckName[],
	stylePrompt: string
): { negativePrompt: string; promptSuffix: string } {
	const additions = failed.map((f) => RETRY_AMENDMENTS[f]).filter((a) => a.length > 0);
	const negativePrompt = [base, ...additions]
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.join(', ');
	const promptSuffix = failed.includes('palette_distance') ? stylePrompt : '';
	return { negativePrompt, promptSuffix };
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

/**
 * Run the judge if it is both wanted and possible.
 *
 * Returns null when it did not run, which the caller must treat as "no
 * opinion" rather than as approval — the distinction is what keeps the report
 * able to say the judge was skipped.
 */
export async function maybeJudge(
	entry: AssetEntry,
	image: Uint8Array,
	deps: JudgeDeps
): Promise<AssetJudgement | null> {
	if (!deps.enabled || !deps.visionSupported) return null;
	return await deps.judge(entry, image);
}
