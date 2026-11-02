import { describe, it, expect, vi, beforeEach } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const notifications = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('#lib/notify.ts', () => notifications);
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { codeSubtasks: 'off', shellSelection: null, commandMemoryLimitPercent: 80 }
	})
);

import {
	runAutonomousCodingPipeline,
	PREFLIGHT,
	DECOMPOSE,
	LOOP,
	FINALIZE,
	DOCUMENT
} from './pipeline';
import { renderTodoPlan, parseTodoPlan, type LoopPlan } from './loopState';
import { reportBoundaryRefusal } from '#lib/shell/boundary.ts';
import {
	DECISIONS,
	PLAN_DIR,
	REPORT,
	TODO,
	decisionsWith,
	fakeRun,
	VERIFY_CMD,
	type FakeRunOptions
} from './pipeline.fixtures';

/**
 * The stages around the loop, driven through the whole pipeline against a
 * fake working directory: what each one does with its turn's result, and when
 * it stops the run.
 */

async function run(opts: FakeRunOptions = {}) {
	const r = fakeRun(tauri.invoke, opts);
	await runAutonomousCodingPipeline(r.ctx);
	return r;
}

beforeEach(() => {
	tauri.invoke.mockReset();
	notifications.notify.mockClear();
});

describe('the run as a whole', () => {
	it('goes through every stage and tells the user it finished', async () => {
		const r = await run();
		expect(r.result).toEqual({ status: 'succeeded', error: null });
		expect(r.steps.map((s) => s.status)).toEqual([
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded',
			'succeeded'
		]);
		expect(r.steps[FINALIZE].output).toBe(`Done — ${REPORT}`);
		expect(r.steps[DOCUMENT].output).toBe('Wrote README.md');
		expect(r.commits).toEqual([
			'chore: pre-ralph baseline',
			'feat: Phase 01 — Scaffold',
			'docs: autonomous coding run report',
			'docs: project README'
		]);
		expect(notifications.notify).toHaveBeenCalledWith(
			'Autonomous coding finished',
			expect.stringContaining('2 done, 0 blocked')
		);
		expect(r.ctx.onSettled).toHaveBeenCalledOnce();
	});

	it('refuses a scheduled run before any turn', async () => {
		const r = await run({ trigger: 'scheduled' });
		expect(r.result?.status).toBe('failed');
		expect(r.result?.error).toContain('not on a schedule');
		expect(r.turns).toEqual([]);
	});

	it('fails without a plan directory', async () => {
		const r = await run({ config: { plan_dir: '' } });
		expect(r.result?.error).toContain('No plan directory configured');
		expect(r.turns).toEqual([]);
	});

	it('marks the live step cancelled when the run is aborted, and does not notify', async () => {
		const r = await run({
			turns: {
				'loop.phase': (o, fr) => {
					fr.ctx.abort.abort();
				}
			}
		});
		expect(r.result?.status).toBe('cancelled');
		expect(r.steps[LOOP].status).toBe('cancelled');
		expect(r.turnsOf('finalize.report')).toEqual([]);
		expect(notifications.notify).not.toHaveBeenCalled();
	});
});

describe('preflight', () => {
	it('stops the run when the model never reports a verdict', async () => {
		const r = await run({ turns: { preflight: () => 'I looked around.' } });
		expect(r.result?.status).toBe('failed');
		expect(r.result?.error).toContain('The model never reported a preflight verdict.');
		expect(r.steps[PREFLIGHT].status).toBe('failed');
		expect(r.turnsOf('decompose')).toEqual([]);
		expect(r.commits).toEqual([]);
	});

	it('lists the blockers it gave, dropping any that are not text', async () => {
		const r = await run({
			turns: {
				preflight: (o, fr) =>
					fr.callTool(o, 'submit_preflight', {
						ready: false,
						blockers: ['Pick a database', 42, 'Name the binary']
					})
			}
		});
		expect(r.result?.error).toBe(
			'Preflight found blockers — fix the plan and re-run:\n- Pick a database\n- Name the binary'
		);
		expect(notifications.notify).toHaveBeenCalledWith(
			'Autonomous coding failed',
			expect.stringContaining('Pick a database')
		);
	});

	it('keeps the decision count and the closing summary in its output', async () => {
		const r = await run();
		expect(r.steps[PREFLIGHT].output).toBe(
			`Ready to code — 2 decision(s) resolved → ${DECISIONS}\n\n---\n\nAll settled.`
		);
	});

	it('asks again for a decisions file it only described, and may ask the user then', async () => {
		let retries = 0;
		const r = await run({
			turns: {
				preflight: (o, fr) => fr.callTool(o, 'submit_preflight', { ready: true }),
				'write.retry': (o, fr) => {
					if (++retries === 2) fr.writeFile(o, DECISIONS, decisionsWith(VERIFY_CMD));
				}
			}
		});
		expect(r.result?.status).toBe('succeeded');
		const asks = r.turnsOf('write.retry');
		expect(asks).toHaveLength(2);
		expect(asks[0].interactive).toBe(true);
		expect(asks[0].userMessage).toContain('ask the user now');
		expect(asks[0].writeRoot).toBe(PLAN_DIR);
		expect(r.steps[PREFLIGHT].output).toContain('0 decision(s) resolved');
	});

	it('gives up after three asks, and a chained run is never interactive', async () => {
		const r = await run({
			trigger: 'chained',
			turns: { preflight: (o, fr) => fr.callTool(o, 'submit_preflight', { ready: true }) }
		});
		expect(r.result?.error).toContain(`The decisions file was never written to ${DECISIONS}`);
		expect(r.turnsOf('preflight')[0].interactive).toBe(false);
		expect(r.turnsOf('preflight')[0].toolAllowlist).not.toContain('ask_user_question');
		const asks = r.turnsOf('write.retry');
		expect(asks).toHaveLength(3);
		expect(asks.every((t) => t.interactive === false)).toBe(true);
		expect(asks[0].userMessage).toContain('Do NOT do anything else');
	});
});

describe('decompose', () => {
	const phase = (id: string, title: string) => ({
		id,
		title,
		verify: 'pending' as const,
		repairs: 0,
		builds: 0
	});

	it('writes the submitted checklist to the TODO file as the loop state', async () => {
		const r = await run();
		expect(r.steps[DECOMPOSE].output).toMatch(
			new RegExp(`^Decomposed the plan into 1 phase\\(s\\) / 2 step\\(s\\) → ${TODO}`)
		);
		const todo = parseTodoPlan(r.files.get(TODO) ?? '');
		expect(todo?.phases.map((p) => [p.title, p.verify])).toEqual([['Scaffold', 'passed']]);
		expect(todo?.items.map((i) => [i.id, i.status])).toEqual([
			['01', 'done'],
			['02', 'done']
		]);
	});

	it('asks again when no checklist is submitted, then accepts the next one', async () => {
		let n = 0;
		const r = await run({
			turns: {
				decompose: (o, fr) => {
					if (++n < 3) return;
					fr.callTool(o, 'submit_task_list', {
						items: [{ title: 'Only', description: 'the one', phase: 'Core' }]
					});
				}
			}
		});
		expect(r.result?.status).toBe('succeeded');
		const turns = r.turnsOf('decompose');
		expect(turns).toHaveLength(3);
		expect(turns[1].userMessage).toContain('You did not call submit_task_list');
		expect(parseTodoPlan(r.files.get(TODO) ?? '')?.items.map((i) => i.title)).toEqual(['Only']);
	});

	it('fails after three turns without a checklist', async () => {
		const r = await run({ turns: { decompose: () => {} } });
		expect(r.result?.error).toContain('never produced a task list');
		expect(r.steps[DECOMPOSE].status).toBe('failed');
		expect(r.turnsOf('decompose')).toHaveLength(3);
		expect(r.turnsOf('loop.phase')).toEqual([]);
	});

	it('parses a guided-planning plan dir instead of asking the model', async () => {
		const r = await run({
			files: {
				[`${PLAN_DIR}overview.md`]: '# Overview\n',
				[`${PLAN_DIR}phase-01-core.md`]:
					'# Phase 01 — Core\n\n## Steps\n\n### Step 1 — Parser\n\n### Step 2 — Printer\n',
				[`${PLAN_DIR}phase-02-cli.md`]: '# Phase 02 — CLI\n\n## Steps\n\n1. Flags\n'
			}
		});
		expect(r.turnsOf('decompose')).toEqual([]);
		expect(r.steps[DECOMPOSE].output).toContain(
			"Parsed the plan's own structure — 2 phase(s), 3 step(s)"
		);
		expect(r.turnsOf('loop.phase').map((t) => t.userMessage.split('\n')[0])).toEqual([
			'Implement ALL of Phase 01 — Core:',
			'Implement ALL of Phase 02 — CLI:'
		]);
	});

	it('resumes a TODO file on disk, working only what is left', async () => {
		const plan: LoopPlan = {
			phases: [{ ...phase('01', 'Core'), verify: 'passed' }, phase('02', 'CLI')],
			items: [
				{ id: '01', title: 'Parser', description: '', status: 'done', attempts: 0, phase: '01' },
				{ id: '02', title: 'Flags', description: 'a', status: 'todo', attempts: 0, phase: '02' },
				{ id: '03', title: 'Help', description: 'b', status: 'blocked', attempts: 3, phase: '02' }
			]
		};
		const r = await run({ files: { [TODO]: renderTodoPlan(plan) } });
		expect(r.turnsOf('decompose')).toEqual([]);
		expect(r.steps[DECOMPOSE].output).toBe(
			`Resumed ${TODO} — 3 step(s): 1 done, 1 blocked, 1 to do`
		);
		const phases = r.turnsOf('loop.phase');
		expect(phases).toHaveLength(1);
		expect(phases[0].userMessage).toContain('- 02. Flags');
		expect(phases[0].userMessage).not.toContain('Help');
		expect(r.steps[FINALIZE].output).toBe(`Done with blockers (1) — ${REPORT}`);
	});

	it('gives a phaseless TODO one catch-all phase, so it is still verified', async () => {
		const plan: LoopPlan = {
			phases: [],
			items: [{ id: '01', title: 'All', description: 'x', status: 'todo', attempts: 0 }]
		};
		const r = await run({ files: { [TODO]: renderTodoPlan(plan) } });
		expect(r.checks).toEqual([VERIFY_CMD]);
		expect(parseTodoPlan(r.files.get(TODO) ?? '')?.phases).toHaveLength(1);
	});
});

describe('finalize', () => {
	it('fails the run on the report step when the report is never written', async () => {
		const r = await run({ turns: { 'finalize.report': () => {} } });
		expect(r.result?.status).toBe('failed');
		expect(r.result?.error).toContain(`The report was never written to ${REPORT}`);
		expect(r.steps[LOOP].status).toBe('succeeded');
		expect(r.steps[FINALIZE].status).toBe('failed');
		expect(r.turnsOf('document.readme')).toEqual([]);
	});

	it('hands the report the commands refused at the project boundary', async () => {
		const r = await run({
			turns: {
				'loop.phase': (o, fr) => {
					reportBoundaryRefusal({ command: 'rm -rf ~/x', reasons: ['outside the project'] });
					fr.writeFile(o, 'src/a.rs', 'x');
					fr.callTool(o, 'submit_phase_result', { note: 'Built.' });
				}
			}
		});
		expect(r.turnsOf('finalize.report')[0].systemPrompt).toContain(
			'`rm -rf ~/x` — outside the project'
		);
		// The listener is gone once the run ends: a later run hears nothing of this one.
		const next = await run();
		expect(next.turnsOf('finalize.report')[0].systemPrompt).not.toContain('rm -rf');
	});
});

describe('document', () => {
	it('asks again for a README it only described, under its own turn kind', async () => {
		let n = 0;
		const r = await run({
			turns: {
				'document.readme': () => {},
				'document.retry': (o, fr) => {
					if (++n === 1) fr.writeFile(o, 'README.md', '# P\n');
				}
			}
		});
		expect(r.turnsOf('document.retry')).toHaveLength(1);
		expect(r.turnsOf('document.retry')[0].writeRoot).toBe('');
		expect(r.steps[DOCUMENT].output).toBe('Wrote README.md');
	});
});
