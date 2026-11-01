import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('#lib/notify.ts', () => ({ notify: vi.fn(async () => {}) }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { codeSubtasks: 'off', shellSelection: null, commandMemoryLimitPercent: 80 }
	})
);

import { runAutonomousCodingPipeline, LOOP, PREFLIGHT } from './pipeline';
import { parseTodoPlan, MAX_PHASE_REPAIR_CYCLES } from './loopState';
import {
	DECISIONS,
	TODO,
	VERIFY_CMD,
	assignedItem,
	decisionsWith,
	fakeRun,
	repairsIt,
	type FakeRunOptions,
	type TurnScript
} from './pipeline.fixtures';

/**
 * The loop stage, driven through the whole pipeline: the phase build turn,
 * the runner's own verification of it, and the repair cycles a failed
 * verification starts. Every assertion is on what the run left behind — the
 * TODO file (the loop state a re-run resumes from), PROGRESS, the commits, and
 * the step's output.
 */

async function run(opts: FakeRunOptions = {}) {
	const r = fakeRun(tauri.invoke, opts);
	await runAutonomousCodingPipeline(r.ctx);
	return r;
}

const todo = (r: { files: Map<string, string> }) => parseTodoPlan(r.files.get(TODO) ?? '');

/** A repair that reports `status`/`note` for its item without changing a file. */
const reports =
	(status: 'done' | 'failed', note: string, itemId?: string): TurnScript =>
	(o, r) =>
		r.callTool(o, 'submit_iteration_result', { item_id: itemId ?? assignedItem(o), status, note });

beforeEach(() => {
	tauri.invoke.mockReset();
});

describe('phase verification', () => {
	it('verifies a built phase with the decisions file’s command, then commits it', async () => {
		const r = await run();
		expect(r.checks).toEqual([VERIFY_CMD]);
		expect(todo(r)?.phases[0].verify).toBe('passed');
		expect(r.commits).toContain('feat: Phase 01 — Scaffold');
		expect(r.progressHeadings()).toEqual([
			'## Phase 01 — Scaffold: build turn finished',
			'## Phase 01 — Scaffold: verification PASSED — phase committed'
		]);
		expect(r.steps[LOOP].output).toMatch(
			/^2 done, 0 blocked of 2 step\(s\), in 0 iteration\(s\); phases: 1 verified, 0 blocked, 0 unverified/
		);
	});

	it('gives the build turn a budget for the items it has to build', async () => {
		expect((await run()).turnsOf('loop.phase')[0].maxIterations).toBe(80);
	});

	it('falls back to the plan overview’s command when the decisions file has none', async () => {
		const r = await run({
			files: {
				'plan/x/overview.md': '# Plan\n\n## Verification command\n\n```sh\ncargo test\n```\n'
			},
			turns: {
				preflight: (o, fr) => {
					fr.writeFile(o, DECISIONS, decisionsWith(null));
					fr.callTool(o, 'submit_preflight', { ready: true });
				}
			}
		});
		expect(r.checks).toEqual(['cargo test']);
	});

	it('says loudly that phases go unverified when no command can be found', async () => {
		const r = await run({
			turns: {
				preflight: (o, fr) => {
					fr.writeFile(o, DECISIONS, decisionsWith(null));
					fr.callTool(o, 'submit_preflight', { ready: true });
				}
			}
		});
		expect(r.checks).toEqual([]);
		expect(r.progressHeadings().filter((h) => h.includes('No verification command'))).toHaveLength(
			1
		);
		expect(todo(r)?.phases[0].verify).toBe('pending');
		expect(r.steps[LOOP].output).toContain('0 verified, 0 blocked, 1 unverified');
		expect(r.turnsOf('loop.phase')[0].userMessage).toContain(
			'No verification command is configured for this run.'
		);
	});
});

describe('repair cycles', () => {
	it('injects a repair item carrying the failure, and re-verifies after it', async () => {
		const r = await run({ verifyExits: [1, 0], turns: { 'loop.repair': repairsIt } });

		const repair = r.turnsOf('loop.repair');
		expect(repair).toHaveLength(1);
		expect(repair[0].userMessage).toContain('EXACTLY ONE checklist item: 03. Repair phase 01');
		expect(repair[0].userMessage).toContain('Verification output:\nFAIL: 1 test');

		expect(r.checks).toEqual([VERIFY_CMD, VERIFY_CMD]);
		const plan = todo(r);
		expect(plan?.phases[0]).toMatchObject({ verify: 'passed', repairs: 1 });
		expect(plan?.items.map((i) => [i.id, i.status, i.repair ?? false])).toEqual([
			['01', 'done', false],
			['02', 'done', false],
			['03', 'done', true]
		]);
		expect(r.progressHeadings()).toEqual([
			'## Phase 01 — Scaffold: build turn finished',
			`## Phase 01 — Scaffold: verification FAILED (repair cycle 1/${MAX_PHASE_REPAIR_CYCLES} → injected 03)`,
			'## Iteration 1 — 03. Repair phase 01 (cycle 1/5): done',
			'## Phase 01 — Scaffold: verification PASSED — phase committed'
		]);
		expect(r.commits).toEqual([
			'chore: pre-ralph baseline',
			'feat: Repair phase 01 (cycle 1/5) [ralph 03/03]',
			// The repair already committed the fix; the phase commit carries the
			// runner's own TODO/PROGRESS rewrites.
			'feat: Phase 01 — Scaffold',
			'docs: autonomous coding run report',
			'docs: project README'
		]);
	});

	it('hands a failed repair’s note to the next cycle', async () => {
		let n = 0;
		const r = await run({
			verifyExits: [1, 1, 0],
			turns: {
				'loop.repair': (o, fr) =>
					++n === 1
						? reports('failed', 'The fixture path is wrong; try tests/data.')(o, fr)
						: repairsIt(o, fr)
			}
		});
		const [, second] = r.turnsOf('loop.repair');
		expect(second.userMessage).toContain(
			'Previous repair note:\nBLOCKED after 1 failed attempt(s). The fixture path is wrong; try tests/data.'
		);
		expect(todo(r)?.items.map((i) => [i.id, i.status])).toEqual([
			['01', 'done'],
			['02', 'done'],
			['03', 'blocked'],
			['04', 'done']
		]);
		expect(r.progressHeadings()).toContain(
			'## Iteration 1 — 03. Repair phase 01 (cycle 1/5): failed'
		);
	});

	it('counts a result for another item as a failed attempt', async () => {
		const r = await run({
			verifyExits: [1, 0],
			turns: { 'loop.repair': reports('done', 'Did item one again.', '01') }
		});
		const item = todo(r)?.items.find((i) => i.id === '03');
		expect(item).toMatchObject({ status: 'blocked', attempts: 1 });
		const progress = r.files.get('plan/x/PROGRESS-coding.md') ?? '';
		expect(progress).toContain(
			'BLOCKED after 1 failed attempt(s). Reported a result for "01" instead of the assigned item 03'
		);
		// A failed repair is not committed as a step.
		expect(r.commits.filter((c) => c.includes('[ralph'))).toEqual([]);
	});

	it('fails a repair that never submits a result', async () => {
		const r = await run({ verifyExits: [1, 0], turns: { 'loop.repair': () => {} } });
		expect(r.files.get('plan/x/PROGRESS-coding.md')).toContain(
			'The iteration ended without a structured result (no submit_iteration_result call).'
		);
	});

	it('blocks the phase once the repair cycles run out, committing the work marked unverified', async () => {
		const r = await run({ verifyExits: [1], turns: { 'loop.repair': repairsIt } });
		expect(r.turnsOf('loop.repair')).toHaveLength(MAX_PHASE_REPAIR_CYCLES);
		expect(r.checks).toHaveLength(MAX_PHASE_REPAIR_CYCLES + 1);
		expect(todo(r)?.phases[0]).toMatchObject({
			verify: 'blocked',
			repairs: MAX_PHASE_REPAIR_CYCLES
		});
		expect(r.progressHeadings().at(-1)).toBe(
			`## Phase 01 — Scaffold: verification still failing after ${MAX_PHASE_REPAIR_CYCLES} ` +
				'repair cycle(s) — phase BLOCKED (work committed, marked UNVERIFIED)'
		);
		expect(r.steps[LOOP].output).toContain('phases: 0 verified, 1 blocked, 0 unverified');
	});

	it('runs a command a repair fixed, and records the change', async () => {
		const r = await run({
			verifyExits: [1, 0],
			turns: {
				'loop.repair': (o, fr) => {
					fr.writeFile(o, DECISIONS, decisionsWith('npm run test:unit'));
					reports('done', 'The command was wrong.')(o, fr);
				}
			}
		});
		expect(r.checks).toEqual([VERIFY_CMD, 'npm run test:unit']);
		expect(r.files.get('plan/x/PROGRESS-coding.md')).toContain(
			'## Verification command changed mid-run\n\n- phase verification: `npm test` → `npm run test:unit`'
		);
		expect(todo(r)?.phases[0].verify).toBe('passed');
	});
});

describe('phase build turns', () => {
	it('retries a phase that built nothing, then blocks its items without verifying', async () => {
		const r = await run({
			turns: {
				'loop.phase': (o, fr) => fr.callTool(o, 'submit_phase_result', { note: 'Read the code.' })
			}
		});
		expect(r.turnsOf('loop.phase')).toHaveLength(3);
		expect(r.checks).toEqual([]);
		expect(todo(r)?.items.map((i) => i.status)).toEqual(['blocked', 'blocked']);
		expect(r.progressHeadings().at(-1)).toContain('NO WORK (attempt 3/3)');
		expect(r.result?.status).toBe('succeeded');
	});
});

describe('git', () => {
	it('runs no git command at all with use_git off, and still verifies', async () => {
		const r = await run({ config: { use_git: false } });
		expect(r.commands.filter((c) => c.startsWith('git'))).toEqual([]);
		expect(r.checks).toEqual([VERIFY_CMD]);
		expect(todo(r)?.phases[0].verify).toBe('passed');
	});

	it('trusts a repair’s "done" with git off, since there is no diff to check', async () => {
		const r = await run({
			config: { use_git: false },
			verifyExits: [1, 0],
			turns: { 'loop.repair': reports('done', 'Fixed.') }
		});
		expect(todo(r)?.items.find((i) => i.id === '03')?.status).toBe('done');
	});

	it('says so when the phase commit fell back to unsigned', async () => {
		const r = await run({ signFails: true });
		expect(r.result?.status).toBe('succeeded');
		expect(r.files.get('plan/x/PROGRESS-coding.md')).toContain('NOTE: commit made UNSIGNED');
	});

	it('stops at the baseline when signing is broken and the job never commits unsigned', async () => {
		const r = await run({ signFails: true, config: { signing_fallback: 'skip' } });
		expect(r.result?.status).toBe('failed');
		expect(r.result?.error).toContain('commit signing is not authorized');
		expect(r.steps[PREFLIGHT].status).toBe('failed');
		expect(r.turnsOf('decompose')).toEqual([]);
	});
});
