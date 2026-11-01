import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeWriteGuard } from '#lib/agent/tools/types.ts';
import type { SubtaskResult } from '#lib/code/runSubtask.ts';
import type { SubtaskWorktree } from '#lib/code/subtaskGit.ts';
import { invokeRouter, unexpectedInvoke, type InvokeRoute } from '#lib/testing/invoke.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

const child = vi.hoisted(() => ({ runSubtask: vi.fn() }));
vi.mock('#lib/code/runSubtask.ts', () => ({ runSubtask: child.runSubtask }));

import { newSubtaskState, type SubtaskState } from '#lib/code/subtask.ts';
import {
	runSubtaskSpec,
	worktreeForSubtask,
	type SubtaskEnv,
	type SubtaskSpec
} from './subtaskRun.ts';

const wt: SubtaskWorktree = {
	path: '/repo-worktrees/.subtasks/s1-1',
	root: '/repo-worktrees/.subtasks/s1-1/app',
	base: 'abc123',
	linked: ['node_modules']
};

function routes(r: Record<string, InvokeRoute>) {
	tauri.invoke.mockImplementation(invokeRouter(r, unexpectedInvoke));
}

function result(over: Partial<SubtaskResult> = {}): SubtaskResult {
	return { outcome: 'done', report: 'All done.', steps: [], stopReason: null, ...over };
}

function spec(over: Partial<SubtaskSpec> = {}): SubtaskSpec {
	return {
		id: 'call-1',
		label: 'fix tests',
		task: 'Fix the tests',
		mode: 'read',
		wt: null,
		...over
	};
}

function env(over: Partial<SubtaskEnv> = {}): SubtaskEnv & { states: SubtaskState[] } {
	const states: SubtaskState[] = [];
	return {
		sessionId: 's1',
		folder: '/repo/app',
		wslDistro: null,
		backend: null,
		effort: null,
		signal: new AbortController().signal,
		stoppedByUser: () => false,
		onState: (s) => states.push(s),
		states,
		...over
	};
}

function initial(mode: 'read' | 'write' = 'read'): SubtaskState {
	return newSubtaskState('call-1', 'fix tests', 'Fix the tests', mode);
}

beforeEach(() => {
	tauri.invoke.mockReset();
	child.runSubtask.mockReset();
	routes({});
});

describe('worktreeForSubtask', () => {
	it('returns the worktree git made', async () => {
		routes({ code_subtask_worktree_create: wt });
		expect(await worktreeForSubtask('/repo/app', 's1', null)).toEqual(wt);
	});

	it('names the worktree after "session" when there is no session id', async () => {
		routes({
			code_subtask_worktree_create: (args) => ({ ...wt, path: `/wt/${String(args?.sessionId)}` })
		});
		const got = await worktreeForSubtask('/repo/app', undefined, null);
		expect(got).toMatchObject({ path: '/wt/session' });
	});

	it('asks for a git repository when the folder is not in one', async () => {
		routes({
			code_subtask_worktree_create: () => {
				throw 'fatal: not in a git repository';
			}
		});
		const got = await worktreeForSubtask('/tmp/loose', 's1', null);
		expect(typeof got).toBe('string');
		expect(got).toContain('need a git repository');
		expect(got).toContain('not in a git repository');
		expect(got).toContain('mode "read"');
	});

	it('asks for a git repository when git is not installed', async () => {
		routes({
			code_subtask_worktree_create: () => {
				throw new Error('Git is not installed');
			}
		});
		const got = await worktreeForSubtask('/repo/app', 's1', 'Ubuntu');
		expect(got).toContain('need a git repository');
		expect(got).toContain('Git is not installed');
	});

	it('passes any other git failure through as a copy failure', async () => {
		routes({
			code_subtask_worktree_create: () => {
				throw 'disk full';
			}
		});
		const got = await worktreeForSubtask('/repo/app', 's1', null);
		expect(got).toMatch(/Couldn't make a copy of the folder.*disk full/);
		expect(got).not.toContain('git repository');
	});
});

describe('runSubtaskSpec in read mode', () => {
	it('hands back the report of a finished subtask', async () => {
		child.runSubtask.mockResolvedValue(result({ report: 'Found 3 callers.' }));
		const e = env();
		const got = await runSubtaskSpec(spec(), e, initial());
		expect(got.failed).toBe(false);
		expect(got.text).toContain('Subtask "fix tests" (done, 0 tool calls)');
		expect(got.text).toContain('Found 3 callers.');
		expect(got.text).not.toContain('applied');
		expect(got.state).toMatchObject({ status: 'done', report: 'Found 3 callers.' });
		expect(got.state.apply).toBeUndefined();
		expect(e.states.at(-1)).toEqual(got.state);
	});

	it('works in the session folder and names the subtask to approvals', async () => {
		child.runSubtask.mockResolvedValue(result());
		await runSubtaskSpec(spec(), env({ requester: () => 'Code · my session' }), initial());
		const opts = child.runSubtask.mock.calls[0][0];
		expect(opts.root).toBe('/repo/app');
		expect(opts.worktree).toBeUndefined();
		expect(opts.requester()).toBe('Code · my session · subtask "fix tests"');
	});

	it('says when there was no report', async () => {
		child.runSubtask.mockResolvedValue(result({ report: '' }));
		const got = await runSubtaskSpec(spec(), env(), initial());
		expect(got.text).toContain('(It gave no report.)');
		expect(got.state.report).toBeNull();
	});

	it('counts tool calls in the singular and plural', async () => {
		const step = { id: 'a' } as unknown as SubtaskResult['steps'][number];
		child.runSubtask.mockResolvedValueOnce(result({ steps: [step] }));
		expect((await runSubtaskSpec(spec(), env(), initial())).text).toContain('1 tool call)');
		child.runSubtask.mockResolvedValueOnce(result({ steps: [step, step] }));
		expect((await runSubtaskSpec(spec(), env(), initial())).text).toContain('2 tool calls)');
	});

	it('reports a failure as failed, with its error', async () => {
		child.runSubtask.mockResolvedValue(
			result({ outcome: 'failed', report: '', error: 'model unreachable' })
		);
		const got = await runSubtaskSpec(spec(), env(), initial());
		expect(got.failed).toBe(true);
		expect(got.text).toContain('(failed,');
		expect(got.text).toContain('model unreachable');
		expect(got.state).toMatchObject({ status: 'failed', error: 'model unreachable' });
	});

	it('falls back to a generic failure line when there is no error', async () => {
		child.runSubtask.mockResolvedValue(result({ outcome: 'failed', report: '' }));
		const got = await runSubtaskSpec(spec(), env(), initial());
		expect(got.text).toContain('it failed.');
	});

	it('tells the parent not to restart a subtask the user stopped', async () => {
		child.runSubtask.mockResolvedValue(result({ outcome: 'stopped', report: 'Half way.' }));
		const got = await runSubtaskSpec(spec(), env({ stoppedByUser: () => true }), initial());
		expect(got.failed).toBe(false);
		expect(got.text).toContain('the user stopped it; do not start it again');
		expect(got.text).toContain('What it had so far:\nHalf way.');
		expect(got.state.status).toBe('stopped');
	});

	it('says a subtask stopped early when the user did not stop it', async () => {
		child.runSubtask.mockResolvedValue(result({ outcome: 'stopped', report: '' }));
		const got = await runSubtaskSpec(spec(), env(), initial());
		expect(got.text).toContain('stopped before it finished');
		expect(got.text).not.toContain('What it had so far');
	});

	it('keeps the card current as the child starts, steps and waits', async () => {
		const step = { id: 'a' } as unknown as SubtaskResult['steps'][number];
		child.runSubtask.mockImplementation(async (o) => {
			o.onAdmitted();
			o.onStep([step]);
			o.onApprovalWait(true);
			o.onApprovalWait(false);
			return result({ steps: [step] });
		});
		const e = env();
		await runSubtaskSpec(spec(), e, initial());
		expect(e.states.map((s) => s.status)).toEqual([
			'running',
			'running',
			'approval',
			'running',
			'done'
		]);
		expect(e.states[1].steps).toHaveLength(1);
	});
});

describe('runSubtaskSpec in write mode', () => {
	const writer = () => spec({ mode: 'write', wt });

	it('runs the child in its worktree', async () => {
		routes({
			code_subtask_worktree_diff: { patch: '', files: [] },
			code_subtask_worktree_discard: null
		});
		child.runSubtask.mockResolvedValue(result());
		await runSubtaskSpec(writer(), env(), initial('write'));
		const opts = child.runSubtask.mock.calls[0][0];
		expect(opts.root).toBe(wt.root);
		expect(opts.worktree).toEqual({ root: wt.root, linked: wt.linked });
	});

	it('says it changed no files when the diff is empty', async () => {
		routes({
			code_subtask_worktree_diff: { patch: '  \n', files: [] },
			code_subtask_worktree_discard: null
		});
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.text).toContain('It changed no files.');
		expect(got.state.apply).toEqual({ status: 'none', files: [] });
	});

	it('lists the files it applied to the folder', async () => {
		const changed = vi.fn();
		const guard: CodeWriteGuard = { acquire: async () => null, changed };
		routes({
			code_subtask_worktree_diff: { patch: 'diff --git a/x', files: ['app/a.ts', 'app/b.ts'] },
			code_subtask_apply: { kind: 'applied', files: ['app/a.ts', 'app/b.ts'] },
			code_subtask_worktree_discard: null
		});
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(writer(), env({ guard }), initial('write'));
		expect(got.failed).toBe(false);
		expect(got.text).toContain('applied to the folder: app/a.ts, app/b.ts');
		expect(got.state).toMatchObject({
			status: 'done',
			apply: { status: 'applied', files: ['app/a.ts', 'app/b.ts'] }
		});
	});

	it('hands back the patch and the kept copy on a conflict', async () => {
		routes({
			code_subtask_worktree_diff: { patch: 'diff --git a/x\n+new', files: ['app/a.ts'] },
			code_subtask_apply: {
				kind: 'conflict',
				files: ['app/a.ts'],
				message: 'patch does not apply'
			}
		});
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.failed).toBe(false);
		expect(got.text).toContain('NOT applied');
		expect(got.text).toContain('(app/a.ts)');
		expect(got.text).toContain('patch does not apply');
		expect(got.text).toContain(`kept at ${wt.path}`);
		expect(got.text).toContain('diff --git a/x\n+new');
		expect(got.state.apply).toMatchObject({ status: 'conflict', worktree: wt.path });
	});

	it('saves a large conflicting patch to a file instead of inlining it', async () => {
		const patch = 'diff --git a/x\n' + '+line\n'.repeat(10_000);
		routes({
			code_subtask_worktree_diff: { patch, files: ['app/a.ts'] },
			code_subtask_apply: { kind: 'conflict', files: ['app/a.ts'], message: 'clash' },
			code_write_overflow: '/tmp/overflow-1.txt'
		});
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.text).toContain('saved to /tmp/overflow-1.txt');
		expect(got.text.length).toBeLessThan(patch.length);
	});

	it('keeps the copy and says where when git fails outright', async () => {
		routes({
			code_subtask_worktree_diff: () => {
				throw 'index.lock exists';
			}
		});
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.failed).toBe(false);
		expect(got.text).toContain('were not applied (index.lock exists)');
		expect(got.text).toContain(`They are in ${wt.path}.`);
		expect(got.state.apply).toMatchObject({ status: 'kept', worktree: wt.path });
	});

	it('keeps the copy when stopped while waiting for the folder', async () => {
		const stop = new AbortController();
		stop.abort();
		const guard: CodeWriteGuard = { acquire: async () => 'another session', changed: vi.fn() };
		routes({ code_subtask_worktree_diff: { patch: 'diff', files: ['app/a.ts'] } });
		child.runSubtask.mockResolvedValue(result());
		const got = await runSubtaskSpec(
			writer(),
			env({ guard, signal: stop.signal }),
			initial('write')
		);
		expect(got.text).toContain('stopped while waiting for the folder');
		expect(got.text).toContain(`They are in ${wt.path}.`);
		expect(got.state.apply).toMatchObject({ status: 'kept', files: ['app/a.ts'] });
	});

	it.each(['stopped', 'failed'] as const)('drops the changes of a %s writer', async (outcome) => {
		routes({ code_subtask_worktree_discard: null });
		child.runSubtask.mockResolvedValue(result({ outcome, report: '', error: 'boom' }));
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.failed).toBe(outcome === 'failed');
		expect(got.text).toContain('Its changes were not applied.');
		expect(got.state.apply).toEqual({ status: 'discarded', files: [] });
	});

	it('still reports a stopped writer when its worktree cannot be removed', async () => {
		routes({
			code_subtask_worktree_discard: () => {
				throw 'busy';
			}
		});
		child.runSubtask.mockResolvedValue(result({ outcome: 'stopped', report: '' }));
		const got = await runSubtaskSpec(writer(), env(), initial('write'));
		expect(got.text).toContain('stopped before it finished');
		expect(got.state.apply?.status).toBe('discarded');
	});
});
