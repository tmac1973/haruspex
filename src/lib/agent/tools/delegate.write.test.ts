import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import type { SubtaskOptions } from '#lib/code/runSubtask.ts';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';

const mocks = vi.hoisted(() => ({
	runSubtask: vi.fn(),
	create: vi.fn(),
	diff: vi.fn(),
	apply: vi.fn(),
	discard: vi.fn(),
	settings: { codeSubtasks: 'write' as 'off' | 'read' | 'write' }
}));

vi.mock('#lib/code/runSubtask.ts', () => ({ runSubtask: mocks.runSubtask }));
vi.mock('#lib/code/subtaskGit.ts', () => ({
	createSubtaskWorktree: mocks.create,
	subtaskWorktreeDiff: mocks.diff,
	applySubtaskPatch: mocks.apply,
	discardSubtaskWorktree: mocks.discard
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/stores/settings.ts')>();
	return { ...real, getSettings: () => ({ ...real.getSettings(), ...mocks.settings }) };
});

import { getToolSchemas } from '#lib/agent/tools/index.ts';
import { executeDelegate } from '#lib/agent/tools/delegate.ts';
import type { SubtaskState } from '#lib/code/subtask.ts';

const wt = {
	path: '/proj-worktrees/.subtasks/s1-1',
	root: '/proj-worktrees/.subtasks/s1-1',
	base: 'abc',
	linked: ['node_modules']
};

function writeGuard() {
	return {
		acquire: vi.fn<CodeWriteGuard['acquire']>(async () => null),
		changed: vi.fn<CodeWriteGuard['changed']>()
	};
}

const ctx = (over = {}) =>
	makeToolContext({
		workingDir: '/proj',
		codeMode: true,
		codeSessionId: 's1',
		requester: () => 'Code · proj',
		subtasksStartedThisTurn: { count: 0 },
		codeWriteGuard: writeGuard(),
		...over
	});

const done = {
	outcome: 'done',
	report: 'added the table',
	steps: [{ id: 'c1' }],
	stopReason: 'complete'
};

beforeEach(() => {
	mocks.settings.codeSubtasks = 'write';
	mocks.runSubtask.mockReset().mockResolvedValue(done);
	mocks.create.mockReset().mockResolvedValue(wt);
	mocks.diff.mockReset().mockResolvedValue({ patch: 'diff --git a/x b/x\n', files: ['x'] });
	mocks.apply.mockReset().mockResolvedValue({ kind: 'applied', files: ['x'] });
	mocks.discard.mockReset().mockResolvedValue(undefined);
});

const modes = (over: Parameters<typeof getToolSchemas>[0]) => {
	const d = getToolSchemas(over).find((s) => s.function.name === 'delegate');
	const params = d?.function.parameters as { properties: { mode: { enum: string[] } } };
	return params.properties.mode.enum;
};

describe('write mode is offered', () => {
	it('with Read and write, outside read-only sessions', () => {
		expect(modes({ hasWorkingDir: true, codeMode: true })).toEqual(['read', 'write']);
		expect(modes({ hasWorkingDir: true, codeMode: true, codeReadOnly: true })).toEqual(['read']);
		mocks.settings.codeSubtasks = 'read';
		expect(modes({ hasWorkingDir: true, codeMode: true })).toEqual(['read']);
	});

	it('and refused where it isn’t', async () => {
		const ro = await executeDelegate({ task: 't', mode: 'write' }, ctx({ codeReadOnly: true }));
		expect(JSON.parse(ro.result).error).toContain('read-only');
		mocks.settings.codeSubtasks = 'read';
		const off = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(JSON.parse(off.result).error).toContain('Settings → Code → Subtasks');
		expect(mocks.create).not.toHaveBeenCalled();
	});
});

describe('a writing subtask', () => {
	it('works in its own worktree and its changes are applied to the folder', async () => {
		const guard = writeGuard();
		const states: SubtaskState[] = [];
		const out = await executeDelegate(
			{ task: 'Add a high-score table.', mode: 'write', label: 'scores' },
			ctx({
				codeWriteGuard: guard,
				toolCallId: 'd1',
				onSubtask: (s: SubtaskState) => states.push(s)
			})
		);
		expect(mocks.create).toHaveBeenCalledWith('/proj', 's1', null);
		const o = mocks.runSubtask.mock.calls[0][0] as SubtaskOptions;
		expect(o).toMatchObject({
			mode: 'write',
			root: wt.root,
			worktree: { root: wt.root, linked: ['node_modules'] }
		});
		expect(mocks.apply).toHaveBeenCalledWith('/proj', 'diff --git a/x b/x\n', null);
		expect(guard.changed).toHaveBeenCalledWith(['/proj/x']);
		expect(mocks.discard).toHaveBeenCalledWith(wt.path, null);
		expect(out.result).toContain('Its changes are applied to the folder: x.');
		expect(states.at(-1)).toMatchObject({
			mode: 'write',
			status: 'done',
			apply: { status: 'applied', files: ['x'] }
		});
	});

	it('says it needs a git repository outside one', async () => {
		mocks.create.mockRejectedValue('/proj is not in a git repository.');
		const out = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(JSON.parse(out.result).error).toContain('Write subtasks need a git repository');
		expect(mocks.runSubtask).not.toHaveBeenCalled();
	});

	it('changing nothing, says so and tidies up', async () => {
		mocks.diff.mockResolvedValue({ patch: '', files: [] });
		const out = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(out.result).toContain('It changed no files.');
		expect(mocks.apply).not.toHaveBeenCalled();
		expect(mocks.discard).toHaveBeenCalled();
	});

	it('on a conflict keeps its copy and hands over the patch', async () => {
		mocks.apply.mockResolvedValue({
			kind: 'conflict',
			files: ['x'],
			message: 'x: patch does not apply'
		});
		const out = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(out.result).toContain('NOT applied');
		expect(out.result).toContain(wt.path);
		expect(out.result).toContain('diff --git a/x b/x');
		expect(mocks.discard).not.toHaveBeenCalled();
	});

	it('stopped or failed, drops its changes', async () => {
		mocks.runSubtask.mockResolvedValueOnce({
			outcome: 'stopped',
			report: '',
			steps: [],
			stopReason: null
		});
		const stopped = await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(stopped.result).toContain('Its changes were not applied.');
		mocks.runSubtask.mockResolvedValueOnce({
			outcome: 'failed',
			report: '',
			error: 'boom',
			steps: [],
			stopReason: null
		});
		await executeDelegate({ task: 't', mode: 'write' }, ctx());
		expect(mocks.diff).not.toHaveBeenCalled();
		expect(mocks.discard).toHaveBeenCalledTimes(2);
	});

	it('shows on its card while a command waits for approval', async () => {
		mocks.runSubtask.mockImplementation(async (o: SubtaskOptions) => {
			o.onAdmitted?.();
			o.onApprovalWait?.(true);
			o.onApprovalWait?.(false);
			return done;
		});
		const states: string[] = [];
		await executeDelegate(
			{ task: 't', mode: 'write' },
			ctx({ onSubtask: (s: SubtaskState) => states.push(s.status) })
		);
		expect(states).toEqual(['queued', 'running', 'approval', 'running', 'done']);
	});
});
