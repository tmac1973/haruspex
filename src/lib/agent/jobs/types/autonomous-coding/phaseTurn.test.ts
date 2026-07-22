import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoopPlan } from './loopState';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/settings', () => ({
	getSettings: vi.fn(() => ({ shellSelection: null }))
}));

import { makePhaseStepHandler, type PhaseTurnDeps } from './pipeline';

/**
 * The submit_step_result handler is the runner's mid-turn ground truth for
 * phase-context mode. These pin its failure semantics: a failed settle keeps
 * the item todo with NO attempt charged (the in-context fix-and-re-report
 * cycle is the retry mechanism, bounded by the turn budget) — a garbage step
 * check once blocked three items at "3 attempts" each while the model's work
 * was fine.
 */
function makeDeps(plan: LoopPlan, step: string | null = null) {
	const recorded: string[] = [];
	let iteration = 0;
	const deps = {
		ctx: {
			job: { working_dir: '/w' },
			patchStep: vi.fn(),
			contextSize: () => 32768,
			visionSupported: () => false,
			buildStreamCallbacks: () => ({}),
			runJobTurn: vi.fn()
		} as unknown as PhaseTurnDeps['ctx'],
		planDir: 'plan/x/',
		maxAttempts: 3,
		signingFallback: 'unsigned' as const,
		getPlan: () => plan,
		setPlan: (p: LoopPlan) => {
			plan = p;
		},
		currentCommands: async () => ({ step, phase: null }),
		record: async (e: string) => {
			recorded.push(e);
		},
		nextIteration: () => ++iteration,
		abortIfCancelled: () => {},
		markNoProgress: async () => {}
	} satisfies PhaseTurnDeps;
	return { deps, recorded, plan: () => plan };
}

function plan(): LoopPlan {
	return {
		phases: [{ id: '01', title: 'Scaffold', verify: 'pending', repairs: 0 }],
		items: [
			{ id: '01', title: 'First', description: '', status: 'todo', attempts: 0, phase: '01' },
			{ id: '02', title: 'Second', description: '', status: 'todo', attempts: 0, phase: '01' }
		]
	};
}

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('makePhaseStepHandler', () => {
	it('enforces in-order reporting without charging anything', async () => {
		const { deps, plan: current } = makeDeps(plan());
		const handler = makePhaseStepHandler(deps, '01');
		const reply = await handler({ item_id: '02', status: 'done', note: 'skipped ahead' });
		expect(reply).toContain('the next item is 01');
		expect(current().items[0].status).toBe('todo');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('keeps a failed item as the CURRENT item, todo, with no attempt charged', async () => {
		const { deps, plan: current } = makeDeps(plan());
		const handler = makePhaseStepHandler(deps, '01');
		const reply = await handler({ item_id: '01', status: 'failed', note: 'not working yet' });
		expect(reply).toContain('stays the CURRENT item');
		expect(current().items[0]).toMatchObject({ status: 'todo', attempts: 0 });
	});

	it('downgrades a done report whose step check fails, again without blocking', async () => {
		mocks.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'run_command_capture')
				return {
					stdout: '',
					stderr: 'SyntaxError: oops',
					exit_code: 1,
					killed: false,
					duration_ms: 3
				};
			throw new Error(`unexpected: ${cmd}`);
		});
		const { deps, plan: current, recorded } = makeDeps(plan(), 'node --check index.js');
		const handler = makePhaseStepHandler(deps, '01');
		const reply = await handler({ item_id: '01', status: 'done', note: 'built it' });
		expect(reply).toContain('stays the CURRENT item');
		expect(current().items[0]).toMatchObject({ status: 'todo', attempts: 0 });
		expect(recorded.join('\n')).toContain('Step check failed');
		expect(recorded.join('\n')).toContain('SyntaxError');
	});

	it('tells the model to wrap up once nothing is left to report', async () => {
		const p = plan();
		p.items = p.items.map((i) => ({ ...i, status: 'done' as const }));
		const { deps } = makeDeps(p);
		const handler = makePhaseStepHandler(deps, '01');
		const reply = await handler({ item_id: '01', status: 'done', note: 'x' });
		expect(reply).toContain('submit_phase_result');
	});
});
