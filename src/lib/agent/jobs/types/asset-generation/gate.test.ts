import { describe, it, expect } from 'vitest';
import {
	amendForRetry,
	betterReport,
	describeFailures,
	maybeJudge,
	rejectionReason,
	retrySeed,
	RETRY_AMENDMENTS,
	CHECK_LABELS
} from './gate';
import type { CheckName } from '$lib/ipc/gen/CheckName';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { AssetEntry } from '$lib/assets/spec/types';

const ALL: CheckName[] = ['alpha_low', 'alpha_high', 'entropy', 'palette_distance'];

function report(failed: CheckName[], paletteDistance = 0): CheckReport {
	return {
		passed: failed.length === 0,
		stats: { alpha: 0.5, entropy: 3, palette_distance: paletteDistance },
		failed
	};
}

const entry: AssetEntry = { id: 'e', kind: 'sprite', prompt: 'a sword', out: 'a/e.png' };

describe('the retry table', () => {
	it('has an amendment for every check the gate can fail', () => {
		// A check with no amendment retries with the identical prompt, which is
		// the most expensive way to produce the same bad image three times.
		for (const name of ALL) {
			const a = RETRY_AMENDMENTS[name];
			expect((a?.positive ?? '') + (a?.negative ?? '')).not.toBe('');
			expect(CHECK_LABELS[name]?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it('asks for an empty margin rather than forbidding one', () => {
		// The bug that lost all four assets of the first real run: alpha_high
		// means "fully opaque, no background to remove", and its amendment used
		// to put "flat background" in the NEGATIVE prompt — telling the model to
		// avoid the very thing that was missing. Three attempts, three
		// identical failures, every asset.
		const a = RETRY_AMENDMENTS.alpha_high;
		expect(a.positive ?? '').toMatch(/empty|margin|alone/);
		expect(a.negative ?? '').not.toMatch(/\bflat background\b/);
	});

	it('asks for a limited palette rather than forbidding one', () => {
		// Same inversion: being off-style is the complaint, so a limited
		// palette is the fix, not the thing to avoid.
		const a = RETRY_AMENDMENTS.palette_distance;
		expect(a.positive ?? '').toContain('limited palette');
		expect(a.negative ?? '').not.toContain('limited palette');
	});

	it('pushes alpha in opposite directions for the two alpha failures', () => {
		// Nothing opaque and fully opaque are opposite problems. One table
		// entry for "alpha" would make the mapping unwritable.
		expect(RETRY_AMENDMENTS.alpha_low.negative).toContain('blank');
		expect(RETRY_AMENDMENTS.alpha_high.positive).toContain('empty');
	});
});

describe('amendForRetry', () => {
	it('appends what we want to the PROMPT and what we do not to the negative', () => {
		const r = amendForRetry('a sword', 'no rust', ['alpha_high'], 'flat pixel art');
		expect(r.prompt).toContain('a sword');
		expect(r.prompt).toContain(RETRY_AMENDMENTS.alpha_high.positive!);
		expect(r.negativePrompt).toContain('no rust');
		expect(r.negativePrompt).toContain('full frame');
		// The thing we are asking for must never land in the negative.
		expect(r.negativePrompt).not.toContain('wide empty margins');
	});

	it('appends one amendment per failure', () => {
		const r = amendForRetry('a sword', '', ['alpha_low', 'entropy'], 'x');
		expect(r.negativePrompt).toContain('blank');
		expect(r.negativePrompt).toContain('featureless');
	});

	it('re-says the style for an off-style result, in the positive prompt', () => {
		const r = amendForRetry('a sword', '', ['palette_distance'], 'flat pixel art');
		expect(r.prompt).toContain('flat pixel art');
		expect(r.prompt).toContain('limited palette');
		expect(r.negativePrompt).not.toContain('flat pixel art');
	});

	it('leaves the prompt alone for a failure with no positive amendment', () => {
		expect(amendForRetry('a sword', '', ['entropy'], 'flat pixel art').prompt).toBe('a sword');
	});

	it('emits no stray commas when there was no base negative', () => {
		const r = amendForRetry('a sword', '', ['entropy'], 'x');
		expect(r.negativePrompt).not.toMatch(/^,|,\s*$|,\s*,/);
	});
});

describe('betterReport', () => {
	it('takes the first report when there is nothing to compare', () => {
		const r = report(['entropy']);
		expect(betterReport(null, r)).toBe(r);
	});

	it('prefers fewer failures', () => {
		const one = report(['entropy']);
		const three = report(['alpha_low', 'entropy', 'palette_distance']);
		expect(betterReport(three, one)).toBe(one);
		expect(betterReport(one, three)).toBe(one);
	});

	it('breaks a tie on palette distance', () => {
		// "failed entropy by 0.02" and "came back blank four times" are
		// different problems and the report has to be able to tell them apart.
		const near = report(['entropy'], 0.02);
		const far = report(['entropy'], 0.9);
		expect(betterReport(far, near)).toBe(near);
		expect(betterReport(near, far)).toBe(near);
	});

	it('keeps the incumbent when neither is better', () => {
		const a = report(['entropy'], 0.1);
		const b = report(['entropy'], 0.1);
		expect(betterReport(a, b)).toBe(a);
	});
});

describe('rejectionReason', () => {
	it('prefers the judge’s prose when the judge is the one rejecting', () => {
		expect(rejectionReason(report([]), { ok: false, reason: 'that is a hammer' })).toBe(
			'that is a hammer'
		);
	});

	it('describes the failed checks in words a user can act on', () => {
		const r = rejectionReason(report(['alpha_high']), null);
		expect(r).toContain('background was never removed');
	});

	it('ignores an approving judge', () => {
		expect(rejectionReason(report(['entropy']), { ok: true, reason: 'fine' })).toBe(
			describeFailures(['entropy'])
		);
	});
});

describe('retrySeed', () => {
	it('is a fresh non-negative integer each time', () => {
		// A pinned seed that fails every check would otherwise retry
		// identically until the budget ran out.
		const seeds = new Set(Array.from({ length: 20 }, () => retrySeed()));
		expect(seeds.size).toBeGreaterThan(15);
		for (const s of seeds) expect(Number.isInteger(s) && s >= 0).toBe(true);
	});
});

describe('maybeJudge', () => {
	const image = new Uint8Array([1]);

	it('runs when it is both wanted and possible', async () => {
		let called = false;
		const v = await maybeJudge(entry, image, {
			enabled: true,
			visionSupported: true,
			judge: async () => {
				called = true;
				return { ok: true, reason: 'looks right' };
			}
		});
		expect(called).toBe(true);
		expect(v?.ok).toBe(true);
	});

	it('is skipped when the model cannot see, and says nothing rather than failing', async () => {
		// Never fail an entry for a capability the user does not have.
		const judge = async () => ({ ok: false, reason: 'should not run' });
		expect(
			await maybeJudge(entry, image, { enabled: true, visionSupported: false, judge })
		).toBeNull();
	});

	it('is skipped when it is turned off', async () => {
		const judge = async () => ({ ok: false, reason: 'should not run' });
		expect(
			await maybeJudge(entry, image, { enabled: false, visionSupported: true, judge })
		).toBeNull();
	});
});
