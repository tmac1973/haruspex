import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

const mocks = vi.hoisted(() => ({
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn(),
	shellProject: vi.fn(),
	prepareTurnSkills: vi.fn()
}));

vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));
vi.mock('#lib/skills/project.ts', () => ({ shellProject: mocks.shellProject }));
vi.mock('#lib/skills/turn.ts', () => ({
	prepareTurnSkills: mocks.prepareTurnSkills,
	skillsPromptSection: () => ''
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: () => ({ contextSize: 16384, vision: false })
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({
		codeMaxIterations: 33,
		codeAutoApprove: false,
		codeRunCommandTimeoutSecs: 30,
		codeSubtasks: 'read',
		imageBackendKind: 'none',
		customSystemPrompt: ''
	}),
	getChatTemplateKwargs: () => ({})
}));

import {
	capReport,
	runSubtask,
	stoppedShort,
	SUBTASK_MAX_ROUNDS,
	SUBTASK_NUDGE_ROUNDS
} from '#lib/code/runSubtask.ts';
import type { SlotLender } from '#lib/agent/tools/types.ts';
import { SUBTASK_REPORT_CHARS } from '#lib/code/system-prompt.ts';

function loopOptions(): AgentLoopOptions {
	return mocks.runAgentLoop.mock.calls[0][0] as AgentLoopOptions;
}

function chunk(content: string) {
	return { delta: { content } } as unknown as Parameters<AgentLoopOptions['onStreamChunk']>[0];
}

/** A loop that writes `text` as its answer and completes. */
function answers(text: string) {
	mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
		o.onStreamChunk(chunk(text));
		o.onComplete({ stopReason: 'complete' } as Parameters<AgentLoopOptions['onComplete']>[0]);
	});
}

const base = {
	root: '/proj',
	task: 'Find the callers of foo.',
	label: 'foo callers',
	mode: 'read' as const
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.shellProject.mockResolvedValue({ root: null, agentsMd: null });
	mocks.prepareTurnSkills.mockResolvedValue(undefined);
});

describe('runSubtask', () => {
	it('runs a read-only Code loop on the task, as a subtask, with its own round limit', async () => {
		answers('foo is called from bar.ts:3');
		const res = await runSubtask({ ...base, sessionId: 's1', effort: 'high' });
		expect(res).toMatchObject({ outcome: 'done', report: 'foo is called from bar.ts:3' });
		const o = loopOptions();
		expect(o).toMatchObject({
			workingDir: '/proj',
			codeSessionId: 's1',
			codeMode: true,
			shellMode: false,
			codeReadOnly: true,
			subtask: { depth: 1 },
			maxIterations: SUBTASK_MAX_ROUNDS,
			reasoningEffort: 'high'
		});
		expect(o.codeWriteGuard).toBeUndefined();
		// The child sees the task, not the parent's conversation.
		const [system, user] = o.messages;
		expect(String(system.content)).toContain('YOUR TASK:\nFind the callers of foo.');
		expect(user).toEqual({ role: 'user', content: 'Find the callers of foo.' });
	});

	it('never asks the queue for a slot: it runs in the lender, or straight in the parent’s', async () => {
		answers('foo is called from bar.ts:3');
		let lent = 0;
		const runInSlot: SlotLender = (fn) => {
			lent += 1;
			return fn();
		};
		await runSubtask({ ...base, runInSlot });
		expect(lent).toBe(1);
		await runSubtask(base);
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(2);
		expect(mocks.withInferenceSlot).not.toHaveBeenCalled();
	});

	it('cuts a long report and says so', async () => {
		answers('x'.repeat(SUBTASK_REPORT_CHARS + 500));
		const res = await runSubtask(base);
		expect(res.report.startsWith('x'.repeat(SUBTASK_REPORT_CHARS))).toBe(true);
		expect(res.report).toContain('[Report cut at 4,000 characters.]');
		expect(capReport('  short  ')).toBe('short');
	});

	it('keeps its tool steps', async () => {
		mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
			const call = { id: 'c1', name: 'code_grep', arguments: { pattern: 'foo' } };
			o.onToolStart(call);
			o.onToolEnd(call, 'bar.ts:3');
			o.onStreamChunk(chunk('foo is called from bar.ts:3'));
			o.onComplete();
		});
		const res = await runSubtask(base);
		expect(res.steps).toEqual([
			expect.objectContaining({
				id: 'c1',
				toolName: 'code_grep',
				status: 'done',
				result: 'bar.ts:3'
			})
		]);
	});

	it('comes back stopped, with what it had, when its signal aborts', async () => {
		const stop = new AbortController();
		mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
			o.onStreamChunk(chunk('partial finding'));
			stop.abort();
			throw new DOMException('Aborted', 'AbortError');
		});
		const res = await runSubtask({ ...base, signal: stop.signal });
		expect(res).toMatchObject({ outcome: 'stopped', report: 'partial finding' });
	});

	it('comes back failed, never throwing, when the loop errors', async () => {
		mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
			o.onError(new Error('server went away'));
		});
		const res = await runSubtask(base);
		expect(res).toMatchObject({ outcome: 'failed', error: 'server went away' });
	});
});

describe('runSubtask in write mode', () => {
	it('writes in its worktree, under a guard of its own, with the parent’s approvals', async () => {
		answers('Added src/sound.ts with tests; npm test passes.');
		const onApprovalWait = vi.fn();
		await runSubtask({
			...base,
			mode: 'write',
			root: '/w/app',
			worktree: { root: '/w/app', linked: ['node_modules'] },
			sessionId: 's1',
			onApprovalWait
		});
		const o = loopOptions();
		expect(o).toMatchObject({ workingDir: '/w/app', codeReadOnly: false, codeSessionId: 's1' });
		expect(o.onApprovalWait).toBe(onApprovalWait);
		expect(await o.codeWriteGuard?.acquire()).toBeNull();
		const system = String(o.messages[0].content);
		expect(system).toContain('Project folder: /w/app');
		expect(system).toContain('your own copy of the project');
		expect(system).toContain('node_modules is shared');
		expect(system).toContain('- fs_write_text');
	});
});

describe('runSubtask when a child stops short', () => {
	const writer = {
		...base,
		mode: 'write' as const,
		root: '/w',
		worktree: { root: '/w', linked: [] }
	};
	const report = 'Added src/sound.ts and its tests; npm test passes (12 new tests).';

	/** A loop that answers `text`, after writing a file when `write` is set. */
	function pass(text: string, write = false) {
		return async (o: AgentLoopOptions) => {
			if (write) {
				const call = {
					id: `w${Math.random()}`,
					name: 'fs_write_text',
					arguments: { path: 'a.ts' }
				};
				o.onToolStart(call);
				o.onToolEnd(call, 'Wrote a.ts');
			}
			o.onStreamChunk(chunk(text));
			o.onComplete();
		};
	}

	it('tells a writer that changed nothing to do it, once, and keeps what it then did', async () => {
		mocks.runAgentLoop
			.mockImplementationOnce(pass('I have the full picture. Let me write the module.'))
			.mockImplementationOnce(pass(report, true));
		const res = await runSubtask(writer);
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(2);
		const second = mocks.runAgentLoop.mock.calls[1][0] as AgentLoopOptions;
		expect(second.maxIterations).toBe(SUBTASK_NUDGE_ROUNDS);
		const [said, told] = second.messages.slice(-2);
		expect(said).toEqual({
			role: 'assistant',
			content: 'I have the full picture. Let me write the module.'
		});
		expect(String(told.content)).toContain("you haven't changed any files yet");
		expect(res).toMatchObject({ outcome: 'done', report });
		expect(res.steps).toHaveLength(1);
	});

	it('asks any child for the report it left out', async () => {
		mocks.runAgentLoop
			.mockImplementationOnce(pass('ok'))
			.mockImplementationOnce(pass('foo is called from bar.ts:3 and baz.ts:9, both with a retry.'));
		const res = await runSubtask(base);
		const told = (mocks.runAgentLoop.mock.calls[1][0] as AgentLoopOptions).messages.at(-1);
		expect(String(told?.content)).toContain('no report');
		expect(res.report).toContain('bar.ts:3');
	});

	it('leaves alone a child that finished, and nudges at most once', async () => {
		mocks.runAgentLoop.mockImplementationOnce(pass(report, true));
		await runSubtask(writer);
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1);
		mocks.runAgentLoop.mockReset().mockImplementation(pass('Let me write it.'));
		const res = await runSubtask(writer);
		expect(mocks.runAgentLoop).toHaveBeenCalledTimes(2);
		expect(res.report).toBe('Let me write it.');
	});

	it('doesn’t count a write that failed', () => {
		const failed = [
			{
				id: 'w',
				toolName: 'fs_edit_text',
				query: 'a.ts',
				status: 'done' as const,
				result: '{"error":"old_str not found"}'
			}
		];
		expect(stoppedShort('write', failed, report)).toContain("haven't changed any files");
		expect(stoppedShort('read', [], report)).toBeNull();
	});
});
