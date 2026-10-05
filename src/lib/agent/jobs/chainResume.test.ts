import { describe, it, expect } from 'vitest';
import { canResumeChain, type ChainRunFacts } from './chainResume';

const chainAssets = {
	job_type: 'asset_generation' as const,
	type_config: JSON.stringify({ coding_run: { plan_dir: 'plan/x/' } })
};
const run = (over: Partial<ChainRunFacts> = {}): ChainRunFacts => ({
	status: 'failed',
	trigger: 'chained',
	stepOutputs: [],
	...over
});

describe('canResumeChain', () => {
	it('offers a chain asset stage that failed or was cancelled', () => {
		expect(canResumeChain(run(), chainAssets)).toBe(true);
		expect(canResumeChain(run({ status: 'cancelled', trigger: 'manual' }), chainAssets)).toBe(true);
	});

	it('offers a chain asset stage that succeeded without handing off', () => {
		// Run 108: re-run by hand before a manual run could hand off.
		const r = run({
			status: 'succeeded',
			trigger: 'manual',
			stepOutputs: ['spec', 'anchor', 'gen', 'report', 'Nothing chained — started manually.']
		});
		expect(canResumeChain(r, chainAssets)).toBe(true);
	});

	it('does not offer an asset stage that handed off', () => {
		const r = run({
			status: 'succeeded',
			stepOutputs: ['', '', '', '', 'Started coding job 35 (run 109) against plan/x/assets.json.']
		});
		expect(canResumeChain(r, chainAssets)).toBe(false);
	});

	it('does not offer a standalone asset job', () => {
		expect(canResumeChain(run(), { job_type: 'asset_generation', type_config: '{}' })).toBe(false);
		expect(canResumeChain(run(), { job_type: 'asset_generation', type_config: null })).toBe(false);
	});

	it('offers a chain-started coding run that stopped, not a hand-started one', () => {
		const coding = { job_type: 'autonomous_coding' as const, type_config: '{}' };
		expect(canResumeChain(run({ status: 'cancelled' }), coding)).toBe(true);
		expect(canResumeChain(run({ status: 'succeeded' }), coding)).toBe(false);
		expect(canResumeChain(run({ trigger: 'manual' }), coding)).toBe(false);
	});

	it('never offers a run that is still going', () => {
		expect(canResumeChain(run({ status: 'running' }), chainAssets)).toBe(false);
		expect(canResumeChain(run({ status: 'queued' }), chainAssets)).toBe(false);
		expect(canResumeChain(run({ status: 'needs_input' }), chainAssets)).toBe(false);
	});

	it('does not offer other job types', () => {
		expect(canResumeChain(run(), { job_type: 'research', type_config: null })).toBe(false);
	});
});
