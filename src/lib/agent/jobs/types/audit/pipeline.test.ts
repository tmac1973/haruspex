import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRouter } from '#lib/testing/invoke.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import {
	SUBMIT_FINDINGS_TOOL,
	SUBMIT_VERDICT_TOOL,
	type AuditFinding
} from '#lib/agent/tools/audit.ts';
import { DEFAULT_AUDIT_SYNTHESIS_PROMPT } from './auditPipeline';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: vi.fn(async () => {}),
	markRunStepStarted: vi.fn(async () => {}),
	markRunStepFinished: vi.fn(async () => {})
}));

import { MAX_AUDIT_RUNS, planAuditSteps, runAuditPipeline } from './pipeline';

function job(typeConfig: object | null, prompt: string | null = 'Audit the repo'): JobWithSteps {
	return {
		id: 1,
		name: 'Audit',
		working_dir: '/w',
		type_config: typeConfig ? JSON.stringify(typeConfig) : null,
		steps: prompt === null ? [] : [{ prompt }]
	} as unknown as JobWithSteps;
}

const FINDING: AuditFinding = {
	file: 'src/a.ts',
	lines: '3',
	title: 'Duplicated parser',
	severity: 'medium'
} as AuditFinding;

type Turn = { userMessage: string; onToolStart?: (c: ResolvedToolCall) => void };

/** A run context whose turns are answered by `answer`, recording step state. */
function harness(j: JobWithSteps, answer: (turn: Turn, n: number) => void | Promise<void>) {
	const h = {
		live: 0,
		steps: {} as Record<number, Record<string, unknown>>,
		finished: null as { status: string; error: string | null } | null,
		settled: 0
	};
	let n = 0;
	const abort = new AbortController();
	const ctx = {
		job: j,
		runId: 5,
		abort,
		runJobTurn: async (opts: Turn) => {
			await answer(opts, n++);
			return { finalText: '', rawText: '' };
		},
		patchStep: (i: number, patch: Record<string, unknown>) => {
			h.steps[i] = { ...h.steps[i], ...patch };
		},
		buildStreamCallbacks: () => ({}),
		setCurrentStepIndex: (i: number) => (h.live = i),
		liveStepIndex: () => h.live,
		contextSize: () => 8192,
		visionSupported: () => false,
		finalizeRun: (status: string, error: string | null) => (h.finished = { status, error }),
		onSettled: () => h.settled++
	} as unknown as JobRunContext;
	return { h, ctx, abort };
}

function submit(turn: Turn, name: string, args: Record<string, unknown>) {
	turn.onToolStart?.({ name, arguments: args } as ResolvedToolCall);
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockImplementation(invokeRouter({}));
});

describe('planAuditSteps', () => {
	it('plans the default three samples and a synthesis step', () => {
		const steps = planAuditSteps(job(null));
		expect(steps.map((s) => s.authored)).toEqual([
			'Audit the repo',
			'Audit the repo',
			'Audit the repo',
			DEFAULT_AUDIT_SYNTHESIS_PROMPT
		]);
	});

	it('clamps the sample count to [1, MAX_AUDIT_RUNS]', () => {
		expect(planAuditSteps(job({ num_runs: 1000 }))).toHaveLength(MAX_AUDIT_RUNS + 1);
		expect(planAuditSteps(job({ num_runs: 0 }))).toHaveLength(2);
		expect(planAuditSteps(job({ num_runs: -4 }))).toHaveLength(2);
	});

	it('plans empty samples when the job has no authored step', () => {
		const steps = planAuditSteps(job({ num_runs: 2 }, null));
		expect(steps.slice(0, 2).map((s) => s.authored)).toEqual(['', '']);
		expect(steps[2].authored).toBe(DEFAULT_AUDIT_SYNTHESIS_PROMPT);
	});
});

describe('runAuditPipeline', () => {
	it('runs every sample, verifies the findings and writes the report', async () => {
		const written: Record<string, unknown>[] = [];
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ fs_write_text: (a) => void written.push(a!) })
		);
		const { h, ctx } = harness(job({ num_runs: 2, output_file: 'AUDIT.md' }), (turn) => {
			if (turn.userMessage.includes('Audit the repo'))
				submit(turn, SUBMIT_FINDINGS_TOOL, { findings: [FINDING] });
			else submit(turn, SUBMIT_VERDICT_TOOL, { verdict: 'confirmed', evidence: 'seen' });
		});

		await runAuditPipeline(ctx);

		expect(h.finished).toEqual({ status: 'succeeded', error: null });
		expect(h.steps[0].status).toBe('succeeded');
		expect(h.steps[0].output).toContain('1 finding(s)');
		expect(h.steps[1].status).toBe('succeeded');
		expect(h.steps[2].status).toBe('succeeded');
		expect(h.steps[2].output).toContain('Duplicated parser');
		expect(h.steps[2].output).toContain('Report written to AUDIT.md');
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({ workdir: '/w', relPath: 'AUDIT.md', overwrite: true });
		expect(h.settled).toBe(1);
	});

	it('still succeeds, with a note, when the report file cannot be written', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				fs_write_text: () => {
					throw 'disk full';
				}
			})
		);
		const { h, ctx } = harness(job({ num_runs: 1, output_file: 'AUDIT.md' }), () => {});
		await runAuditPipeline(ctx);
		expect(h.finished?.status).toBe('succeeded');
		expect(h.steps[1].output).toContain('Could not write AUDIT.md: disk full');
	});

	it('marks the live sample failed when its turn throws', async () => {
		const { h, ctx } = harness(job({ num_runs: 3 }), (_turn, n) => {
			if (n === 1) throw new Error('model went away');
		});
		await runAuditPipeline(ctx);

		expect(h.finished).toEqual({ status: 'failed', error: 'model went away' });
		expect(h.steps[0].status).toBe('succeeded');
		expect(h.steps[1]).toMatchObject({ status: 'failed', error: 'model went away' });
		expect(h.steps[2]).toBeUndefined();
		expect(h.settled).toBe(1);
	});

	it('marks the synthesis step failed when a verification turn throws', async () => {
		const { h, ctx } = harness(job({ num_runs: 1 }), (turn) => {
			if (turn.userMessage.includes('Audit the repo'))
				submit(turn, SUBMIT_FINDINGS_TOOL, { findings: [FINDING] });
			else throw new Error('verify broke');
		});
		await runAuditPipeline(ctx);
		expect(h.finished?.status).toBe('failed');
		expect(h.steps[1]).toMatchObject({ status: 'failed', error: 'verify broke' });
	});

	it('marks the run and the live step cancelled when a sample is aborted', async () => {
		const { h, ctx, abort } = harness(job({ num_runs: 3 }), (_turn, n) => {
			if (n === 1) {
				abort.abort();
				throw new DOMException('Aborted', 'AbortError');
			}
		});
		await runAuditPipeline(ctx);

		expect(h.finished).toEqual({ status: 'cancelled', error: 'Cancelled by user' });
		expect(h.steps[0].status).toBe('succeeded');
		expect(h.steps[1].status).toBe('cancelled');
		expect(h.steps[2]).toBeUndefined();
		expect(h.settled).toBe(1);
	});
});
