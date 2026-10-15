import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { SubtaskOptions } from '#lib/code/runSubtask.ts';

const mocks = vi.hoisted(() => ({
	runSubtask: vi.fn(),
	settings: { codeSubtasks: 'read' as 'off' | 'read' | 'write' }
}));

vi.mock('#lib/code/runSubtask.ts', () => ({ runSubtask: mocks.runSubtask }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return { ...real, getSettings: () => ({ ...real.getSettings(), ...mocks.settings }) };
});

import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { executeDelegate, subtaskLabel, SUBTASKS_PER_TURN } from '#lib/agent/tools/delegate.ts';
import { SubtaskStops } from '#lib/code/subtask.ts';

const ctx = (over = {}) =>
	makeToolContext({
		workingDir: '/proj',
		codeMode: true,
		codeSessionId: 's1',
		codeEffort: 'low',
		wslDistro: null,
		requester: () => 'Code · proj',
		subtasksStartedThisTurn: { count: 0 },
		...over
	});

const lastOptions = () => mocks.runSubtask.mock.calls.at(-1)![0] as SubtaskOptions;

beforeEach(() => {
	mocks.runSubtask.mockReset().mockResolvedValue({
		outcome: 'done',
		report: 'foo is called from bar.ts:3',
		steps: [{ id: 'c1' }, { id: 'c2' }],
		stopReason: 'complete'
	});
	mocks.settings.codeSubtasks = 'read';
});

const names = (opts: Parameters<typeof getToolSchemas>[0]) =>
	getToolSchemas(opts).map((s) => s.function.name);

describe('delegate is offered', () => {
	it('in the Code tab only', () => {
		expect(names({ hasWorkingDir: true, codeMode: true })).toContain('delegate');
		expect(names({ hasWorkingDir: true, codeMode: true, shellMode: true })).not.toContain(
			'delegate'
		);
		expect(names({ hasWorkingDir: true })).not.toContain('delegate');
	});

	it('not to a subtask, which also loses whatever needs the user', () => {
		const child = names({ hasWorkingDir: true, codeMode: true, interactive: true, subtask: true });
		for (const name of [
			'delegate',
			'command_output',
			'command_stop',
			'open_in_shell',
			'open_in_editor'
		]) {
			expect(child).not.toContain(name);
		}
		expect(child).toContain('code_grep');
		expect(child).toContain('run_command');
	});

	it('not when Settings → Code → Subtasks is off', () => {
		mocks.settings.codeSubtasks = 'off';
		expect(names({ hasWorkingDir: true, codeMode: true })).not.toContain('delegate');
	});
});

describe('delegate', () => {
	it('runs the task as a read-only subtask of the session and returns its report', async () => {
		const runInSlot = vi.fn();
		const signal = new AbortController().signal;
		const out = await executeDelegate(
			{ task: ' Find the callers of foo. ', mode: 'read', label: 'foo callers' },
			ctx({ runInSlot, signal })
		);
		expect(out.result).toBe(
			'Subtask "foo callers" (done, 2 tool calls):\n\nfoo is called from bar.ts:3'
		);
		expect(lastOptions()).toMatchObject({
			sessionId: 's1',
			root: '/proj',
			task: 'Find the callers of foo.',
			label: 'foo callers',
			mode: 'read',
			effort: 'low',
			runInSlot,
			signal
		});
		expect(lastOptions().requester?.()).toBe('Code · proj · subtask "foo callers"');
	});

	it('refuses inside a subtask', async () => {
		const out = await executeDelegate({ task: 't', mode: 'read' }, ctx({ subtask: { depth: 1 } }));
		expect(out.result).toContain('cannot start subtasks');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
	});

	it('refuses when Subtasks are off, naming the setting', async () => {
		mocks.settings.codeSubtasks = 'off';
		const out = await executeDelegate({ task: 't', mode: 'read' }, ctx());
		expect(out.result).toContain('Settings → Code → Subtasks');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
	});

	it(`refuses the ${SUBTASKS_PER_TURN + 1}th of one turn`, async () => {
		const turn = ctx();
		for (let i = 0; i < SUBTASKS_PER_TURN; i++) {
			await executeDelegate({ task: `t${i}`, mode: 'read' }, turn);
		}
		const out = await executeDelegate({ task: 'one more', mode: 'read' }, turn);
		expect(out.result).toContain(`already started ${SUBTASKS_PER_TURN} subtasks`);
		expect(mocks.runSubtask).toHaveBeenCalledTimes(SUBTASKS_PER_TURN);
	});

	it('says when a subtask was stopped or failed', async () => {
		mocks.runSubtask.mockResolvedValueOnce({
			outcome: 'stopped',
			report: 'half',
			steps: [{ id: 'c1' }],
			stopReason: null
		});
		const stopped = await executeDelegate({ task: 't', mode: 'read', label: 'x' }, ctx());
		expect(stopped.result).toContain('Subtask "x" (stopped, 1 tool call): stopped');
		expect(stopped.result).toContain('half');
		mocks.runSubtask.mockResolvedValueOnce({
			outcome: 'failed',
			report: '',
			error: 'server went away',
			steps: [],
			stopReason: null
		});
		const failed = await executeDelegate({ task: 't', mode: 'read', label: 'x' }, ctx());
		expect(JSON.parse(failed.result).error).toContain('server went away');
	});

	it('wants a task, and only read mode while writing is off', async () => {
		expect((await executeDelegate({ mode: 'read' }, ctx())).result).toContain('requires a task');
		const write = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(JSON.parse(write.result).error).toContain('Write subtasks are off');
	});

	it('labels a call by its label, else the start of its task', () => {
		expect(subtaskLabel({ label: ' Callers ', task: 'x' })).toBe('Callers');
		expect(subtaskLabel({ task: 'a\n b' })).toBe('a b');
		expect(subtaskLabel({ task: 'y'.repeat(80) })).toBe(`${'y'.repeat(59)}…`);
	});
});

describe('delegate in a job', () => {
	const job = {
		thinkingEnabled: false,
		reasoningEffort: 'low',
		samplingSource: 'server' as const,
		samplingParams: null
	};
	// A job's turn: no Code session, an allowlist rather than codeMode.
	const jobCtx = (over = {}) =>
		makeToolContext({
			workingDir: '/proj',
			jobSubtasks: job,
			subtasksStartedThisTurn: { count: 0 },
			...over
		});

	it('runs a read subtask that follows the job’s model settings', async () => {
		const out = await executeDelegate({ task: 'Find foo.', mode: 'read', label: 'foo' }, jobCtx());
		expect(out.result).toContain('Subtask "foo" (done');
		expect(lastOptions()).toMatchObject({ root: '/proj', mode: 'read', job });
	});

	it('refuses write mode even while Settings allow writers', async () => {
		mocks.settings.codeSubtasks = 'write';
		const out = await executeDelegate({ task: 't', mode: 'write' }, jobCtx());
		expect(JSON.parse(out.result).error).toContain('only read');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
	});

	it('refuses background mode: a job has no later turn to report to', async () => {
		const out = await executeDelegate({ task: 't', mode: 'read', background: true }, jobCtx());
		expect(out.result).toContain('Background subtasks are not available here');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
	});

	it('is offered to a job turn that lists it', () => {
		const tools = names({ hasWorkingDir: true, toolAllowlist: ['code_grep', 'delegate'] });
		expect(tools).toContain('delegate');
	});
});

describe('delegate cards and stops', () => {
	it('publishes its card queued, running, with steps, then done', async () => {
		mocks.runSubtask.mockImplementation(async (o: SubtaskOptions) => {
			o.onAdmitted?.();
			o.onStep?.([{ id: 'c1', toolName: 'code_grep', query: 'foo', status: 'running' }]);
			return { outcome: 'done', report: 'r', steps: [{ id: 'c1' }], stopReason: 'complete' };
		});
		const states: { status: string; steps: unknown[] }[] = [];
		await executeDelegate(
			{ task: 't', mode: 'read', label: 'l' },
			ctx({
				toolCallId: 'd1',
				onSubtask: (s: { status: string; steps: unknown[] }) => states.push(s)
			})
		);
		expect(states.map((s) => s.status)).toEqual(['queued', 'running', 'running', 'done']);
		expect(states[2].steps).toHaveLength(1);
		expect(states.every((s) => (s as unknown as { id: string }).id === 'd1')).toBe(true);
	});

	it('gives each subtask its own stop, which the turn’s also pulls', async () => {
		const stops = new SubtaskStops();
		const turn = new AbortController();
		const signals: AbortSignal[] = [];
		mocks.runSubtask.mockImplementation(
			(o: SubtaskOptions) =>
				new Promise((resolve) => {
					signals.push(o.signal!);
					o.signal!.addEventListener('abort', () =>
						resolve({ outcome: 'stopped', report: '', steps: [], stopReason: null })
					);
				})
		);
		const shared = { subtaskStops: stops, signal: turn.signal };
		const one = executeDelegate(
			{ task: 'a', mode: 'read', label: 'a' },
			ctx({ ...shared, toolCallId: 'a' })
		);
		const two = executeDelegate(
			{ task: 'b', mode: 'read', label: 'b' },
			ctx({ ...shared, toolCallId: 'b' })
		);
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		stops.stop('a');
		expect((await one).result).toContain('the user stopped it');
		expect(signals[1].aborted).toBe(false);
		turn.abort();
		expect((await two).result).toContain('stopped before it finished');
		expect(stops.size).toBe(0);
	});
});

describe('delegate in the background', () => {
	it('hands the subtask to the session and returns at once', async () => {
		const start = vi.fn();
		const states: { background?: boolean; status: string }[] = [];
		const out = await executeDelegate(
			{ task: 'Review the loop.', mode: 'read', label: 'review', background: true },
			ctx({
				toolCallId: 'd9',
				startBackgroundSubtask: start,
				onSubtask: (s: never) => states.push(s)
			})
		);
		expect(out.result).toContain('Started subtask "review" in the background (id d9)');
		expect(out.result).toContain('do NOT wait or poll');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'd9',
				label: 'review',
				task: 'Review the loop.',
				mode: 'read'
			}),
			expect.objectContaining({ background: true, status: 'queued' })
		);
		expect(states).toEqual([expect.objectContaining({ background: true, status: 'queued' })]);
	});

	it('is refused where no session can take it, and counts toward the turn’s cap', async () => {
		const none = await executeDelegate({ task: 't', mode: 'read', background: true }, ctx());
		expect(JSON.parse(none.result).error).toContain('not available here');
		const turn = ctx({ startBackgroundSubtask: vi.fn() });
		for (let i = 0; i < SUBTASKS_PER_TURN; i++) {
			await executeDelegate({ task: `t${i}`, mode: 'read', background: true }, turn);
		}
		const over = await executeDelegate({ task: 'x', mode: 'read' }, turn);
		expect(over.result).toContain(`already started ${SUBTASKS_PER_TURN}`);
	});
});
