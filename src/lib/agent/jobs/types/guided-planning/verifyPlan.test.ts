import { describe, it, expect, vi } from 'vitest';
import { verifyPlan, verificationSummary } from './pipeline';

const PROBLEMS = [
	'- (a) phase-02-api.md: depends on phase 03',
	'- (c) phase-04-engine.md: the loop is a full implementation'
].join('\n');

/** A verifier that answers each read from `verdicts` in turn, and a reviser that writes a file. */
function io(verdicts: string[], wrote: string[] = ['phase-02-api.md']) {
	const verify = vi.fn(async () => verdicts.shift() ?? 'PLAN OK');
	const revise = vi.fn(async () => wrote);
	return { verify, revise, abortIfCancelled: vi.fn() };
}

describe('verifyPlan — lite', () => {
	it('reads once and stops when the plan is clean', async () => {
		const deps = io(['PLAN OK']);
		const out = await verifyPlan('lite', deps);
		expect(out).toEqual({ clean: true, openProblems: '', rounds: 1 });
		expect(deps.revise).not.toHaveBeenCalled();
	});

	it('revises once and never reads again', async () => {
		const deps = io([PROBLEMS, PROBLEMS]);
		const out = await verifyPlan('lite', deps);
		expect(deps.verify).toHaveBeenCalledTimes(1);
		expect(deps.revise).toHaveBeenCalledTimes(1);
		expect(deps.revise).toHaveBeenCalledWith(PROBLEMS);
		// Nothing confirmed the revise, so the first verdict stays open.
		expect(out).toEqual({ clean: false, openProblems: PROBLEMS, rounds: 1 });
	});

	it('carries every finding of that verdict to the handoff', async () => {
		const out = await verifyPlan('lite', io([PROBLEMS]));
		const summary = verificationSummary('lite', out);
		expect(summary.findings).toHaveLength(2);
		expect(summary.message).toMatch(/^Verification: lite \(1 round\)/);
		expect(summary.message).toContain('1 blocking, 1 advisory');
	});
});

describe('verifyPlan — full', () => {
	it('loops until a read comes back clean', async () => {
		const deps = io([PROBLEMS, PROBLEMS, 'PLAN OK']);
		const out = await verifyPlan('full', deps);
		expect(out).toEqual({ clean: true, openProblems: '', rounds: 3 });
		expect(deps.revise).toHaveBeenCalledTimes(2);
	});

	it('stops at five reads, the last one verify-only', async () => {
		const deps = io(Array(10).fill(PROBLEMS));
		const out = await verifyPlan('full', deps);
		expect(deps.verify).toHaveBeenCalledTimes(5);
		expect(deps.revise).toHaveBeenCalledTimes(4);
		expect(out.clean).toBe(false);
		expect(verificationSummary('full', out).message).toMatch(/problems still open/);
	});

	it('stops when a revise writes nothing', async () => {
		const deps = io([PROBLEMS, PROBLEMS], []);
		await verifyPlan('full', deps);
		expect(deps.verify).toHaveBeenCalledTimes(1);
	});
});
