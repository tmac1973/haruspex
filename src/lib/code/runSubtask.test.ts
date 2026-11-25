import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';

const mocks = vi.hoisted(() => ({
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn(),
	shellProject: vi.fn(),
	prepareTurnSkills: vi.fn(),
	descriptor: vi.fn()
}));

vi.mock('#lib/agent/loop.ts', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	withInferenceSlot: mocks.withInferenceSlot,
	laneKey: (b?: { baseUrl: string }) => (b ? `remote:${b.baseUrl}` : 'local')
}));
vi.mock('#lib/skills/project.ts', () => ({ shellProject: mocks.shellProject }));
vi.mock('#lib/skills/turn.ts', () => ({
	prepareTurnSkills: mocks.prepareTurnSkills,
	skillsPromptSection: () => ''
}));
vi.mock('#lib/inference/descriptor.ts', () => ({
	resolveBackendDescriptor: mocks.descriptor
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({
			codeMaxIterations: 33,
			codeAutoApprove: false,
			codeRunCommandTimeoutSecs: 30,
			codeSubtasks: 'read',
			imageModels: [],
			codeCustomSystemPrompt: ''
		}),
		getChatTemplateKwargs: () => ({})
	})
);

import {
	capReport,
	onOwnLane,
	runSubtask,
	stoppedShort,
	SUBTASK_MAX_ROUNDS,
	SUBTASK_NUDGE_ROUNDS
} from '#lib/code/runSubtask.ts';
import type { SlotLender } from '#lib/agent/tools/types.ts';
import type { SubtaskProfile } from '#lib/code/subtaskProfile.ts';
import { SUBTASK_REPORT_CHARS } from '#lib/code/systemPrompt.ts';

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
	mocks.descriptor.mockReturnValue({ contextSize: 16384, vision: false });
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

	it('passes each model call’s usage up', async () => {
		answers('done');
		const onUsage = vi.fn();
		await runSubtask({ ...base, onUsage });
		const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
		loopOptions().onUsageUpdate?.(usage);
		expect(onUsage).toHaveBeenCalledWith(usage);
	});

	it('follows a job’s model settings, and runs with nobody to answer', async () => {
		answers('foo is called from bar.ts:3');
		const onCallStats = vi.fn();
		await runSubtask({
			...base,
			effort: 'high',
			job: {
				thinkingEnabled: false,
				reasoningEffort: 'low',
				samplingSource: 'custom',
				samplingParams: null,
				onCallStats
			}
		});
		expect(loopOptions()).toMatchObject({
			reasoningEffort: 'low',
			thinkingEnabled: false,
			samplingSource: 'custom',
			interactive: false,
			onCallStats
		});
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

	it('gives its loop a slot of its own to give back, and never the parent’s', async () => {
		answers('foo is called from bar.ts:3');
		const slot = { held: true, release: () => {}, reacquire: async () => {} };
		await runSubtask({ ...base, runInSlot: (fn) => fn(slot) });
		expect(loopOptions().slot).toBe(slot);
		await runSubtask(base);
		expect((mocks.runAgentLoop.mock.calls[1][0] as AgentLoopOptions).slot).toBeUndefined();
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

	it('doesn’t nudge a writer whose task said to leave the files alone', () => {
		expect(stoppedShort('write', [], report, 'Run npm test. Do not touch any files.')).toBeNull();
		expect(stoppedShort('write', [], report, 'Run it without changing the files.')).toBeNull();
		expect(stoppedShort('write', [], report, 'Add a high-score table.')).toContain(
			'Only your next reply is passed on'
		);
	});
});

const openrouter = { baseUrl: 'https://openrouter.ai', modelId: 'frontier/3d' };

function profile(over: Partial<SubtaskProfile> = {}): SubtaskProfile {
	return {
		backend: openrouter,
		system: 'You build 3D assets.',
		firstMessage: 'Make a crate at assets/crate.js.',
		images: [],
		tools: ['fs_read_text', 'fs_write_text', 'fs_edit_text', 'check_3d'],
		helpers: ['3d'],
		writablePaths: ['assets/crate.js', 'assets/crate.glb'],
		maxRounds: 80,
		maxCostUsd: null,
		finalReport: (why) => `Report now (${why}).`,
		...over
	};
}

interface Pass {
	tools: string[] | undefined;
	maxIterations: number | undefined;
	rounds: number;
	/** The last message when the pass started: what it was asked. */
	asked: unknown;
}

/**
 * A loop that makes `script[n]` rounds on its nth pass (Infinity: tool calls
 * for ever) before answering, asking `stopBeforeRound` as the real one does.
 * Each round reports usage, with `cost` when given.
 */
function scripted(script: number[], cost?: number): Pass[] {
	const passes: Pass[] = [];
	mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
		const want = script[passes.length] ?? 1;
		const pass: Pass = {
			tools: o.toolAllowlist ? [...o.toolAllowlist] : undefined,
			maxIterations: o.maxIterations,
			rounds: 0,
			asked: o.messages[o.messages.length - 1]?.content
		};
		passes.push(pass);
		const max = o.maxIterations ?? 8;
		for (let i = 0; i < max; i++) {
			if (i > 0 && o.stopBeforeRound?.()) {
				o.onComplete({ stopReason: 'capped' });
				return;
			}
			pass.rounds++;
			o.onUsageUpdate?.({
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
				...(cost === undefined ? {} : { cost })
			});
			if (pass.rounds >= want) {
				o.onStreamChunk(chunk(`answer ${passes.length}`));
				o.onComplete({ stopReason: 'complete' });
				return;
			}
		}
		o.onComplete({ stopReason: 'max_iterations' });
	});
	return passes;
}

describe('runSubtask with a profile', () => {
	beforeEach(() => {
		mocks.withInferenceSlot.mockImplementation((_o: unknown, fn: (s?: unknown) => unknown) =>
			fn(undefined)
		);
	});

	it('runs on its own model with its prompt, tools, helpers and files', async () => {
		scripted([1]);
		const guard = { acquire: vi.fn(async () => null), changed: vi.fn() };
		const res = await runSubtask({ ...base, profile: profile(), guard });
		expect(res).toMatchObject({ outcome: 'done', report: 'answer 1' });
		const o = loopOptions();
		expect(o).toMatchObject({
			backend: openrouter,
			workingDir: '/proj',
			codeReadOnly: false,
			toolAllowlist: ['fs_read_text', 'fs_write_text', 'fs_edit_text', 'check_3d'],
			subtaskHelpers: ['3d'],
			codeHelpers: ['3d'],
			writablePaths: ['assets/crate.js', 'assets/crate.glb'],
			subtask: { depth: 1 }
		});
		expect(o.codeWriteGuard).toBe(guard);
		expect(o.messages[0]).toEqual({ role: 'system', content: 'You build 3D assets.' });
		expect(o.messages[1]).toEqual({ role: 'user', content: 'Make a crate at assets/crate.js.' });
		// No project read or skills: the profile's prompt is the whole prompt.
		expect(mocks.shellProject).not.toHaveBeenCalled();
	});

	it('sends the reference images with the first message when its model sees them', async () => {
		mocks.descriptor.mockReturnValue({ contextSize: 16384, vision: true });
		scripted([1]);
		const images = [{ path: 'refs/crate.png', dataUrl: 'data:image/png;base64,AA' }];
		await runSubtask({ ...base, profile: profile({ images }) });
		expect(loopOptions().messages[1]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Make a crate at assets/crate.js.' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
			]
		});
	});

	it('names the images instead when its model cannot see them', async () => {
		scripted([1]);
		const images = [{ path: 'refs/crate.png', dataUrl: 'data:image/png;base64,AA' }];
		await runSubtask({ ...base, profile: profile({ images }) });
		const content = String(loopOptions().messages[1].content);
		expect(content).toContain('refs/crate.png');
		expect(content).not.toContain('base64');
	});

	it('stops at its round cap, then asks for the report with no tools', async () => {
		const passes = scripted([Infinity, 1]);
		const res = await runSubtask({ ...base, profile: profile({ maxRounds: 5 }) });
		expect(passes.map((p) => p.rounds)).toEqual([5, 1]);
		expect(passes[1]).toMatchObject({ tools: [], maxIterations: 1, asked: 'Report now (rounds).' });
		expect(res.report).toBe('answer 2');
	});

	it('stops before the call that would pass its dollar cap', async () => {
		const passes = scripted([Infinity, 1], 0.3);
		await runSubtask({ ...base, profile: profile({ maxCostUsd: 0.5 }) });
		expect(passes.map((p) => p.rounds)).toEqual([2, 1]);
		expect(passes[1].asked).toBe('Report now (cost).');
	});

	it('never stops on cost with no dollar cap', async () => {
		const passes = scripted([30], 5);
		await runSubtask({ ...base, profile: profile({ maxCostUsd: null }) });
		expect(passes).toHaveLength(1);
		expect(passes[0].rounds).toBe(30);
	});

	it('passes each call up, priced by its own model', async () => {
		scripted([2], 0.25);
		const onUsage = vi.fn();
		await runSubtask({ ...base, profile: profile(), onUsage });
		expect(onUsage).toHaveBeenCalledTimes(2);
		expect(onUsage.mock.calls[0][0]).toMatchObject({ total_tokens: 15, cost: 0.25 });
	});

	it('runs one more pass when its done check nudges, and none when it is done', async () => {
		let passes = scripted([2, 1]);
		const doneCheck = vi.fn(async () => 'crate.glb is missing: write it and check it.');
		await runSubtask({ ...base, profile: profile({ doneCheck }) });
		expect(passes).toHaveLength(2);
		expect(passes[1].asked).toBe('crate.glb is missing: write it and check it.');
		expect(passes[1].tools).toContain('check_3d');

		passes = scripted([2, 1]);
		await runSubtask({ ...base, profile: profile({ doneCheck: async () => null }) });
		expect(passes).toHaveLength(1);
	});

	it('nudges only once, even when the check still fails', async () => {
		const passes = scripted([1, 1, 1]);
		const doneCheck = vi.fn(async () => 'Still failing.');
		await runSubtask({ ...base, profile: profile({ doneCheck }) });
		expect(passes).toHaveLength(2);
		expect(doneCheck).toHaveBeenCalledTimes(1);
	});

	it('counts both passes against the round cap', async () => {
		const passes = scripted([4, Infinity, 1]);
		const doneCheck = async () => 'Fix it.';
		await runSubtask({ ...base, profile: profile({ maxRounds: 6, doneCheck }) });
		expect(passes.map((p) => p.rounds)).toEqual([4, 2, 1]);
		expect(passes[2]).toMatchObject({ tools: [], asked: 'Report now (rounds).' });
	});

	it('asks for the report instead of nudging when no rounds are left', async () => {
		const passes = scripted([3, 1]);
		const doneCheck = vi.fn(async () => 'Fix it.');
		await runSubtask({ ...base, profile: profile({ maxRounds: 3, doneCheck }) });
		expect(passes).toHaveLength(2);
		expect(passes[1]).toMatchObject({ tools: [], asked: 'Report now (rounds).' });
	});

	it('takes a slot of its own on another lane, never the parent’s', async () => {
		scripted([1]);
		const lent = vi.fn();
		const runInSlot: SlotLender = (fn) => {
			lent();
			return fn();
		};
		await runSubtask({ ...base, backend: null, runInSlot, profile: profile() });
		expect(mocks.withInferenceSlot).toHaveBeenCalledWith(
			expect.objectContaining({ consumer: 'subagent', backend: openrouter }),
			expect.any(Function)
		);
		expect(lent).not.toHaveBeenCalled();
	});

	it('gives the parent’s slot back while it runs on another lane, then takes it again', async () => {
		scripted([1]);
		const order: string[] = [];
		const parentSlot = {
			held: true,
			release: vi.fn(() => order.push('release')),
			reacquire: vi.fn(async () => {
				order.push('reacquire');
			})
		};
		mocks.withInferenceSlot.mockImplementation((_o: unknown, fn: (s?: unknown) => unknown) => {
			order.push('own slot');
			return fn(undefined);
		});
		await runSubtask({ ...base, backend: null, parentSlot, profile: profile() });
		expect(order).toEqual(['release', 'own slot', 'reacquire']);
	});

	it('keeps the parent’s slot on the parent’s lane', async () => {
		scripted([1]);
		const parentSlot = { held: true, release: vi.fn(), reacquire: vi.fn(async () => {}) };
		await runSubtask({ ...base, backend: openrouter, parentSlot, profile: profile() });
		expect(parentSlot.release).not.toHaveBeenCalled();
	});

	it('leaves a stopped take-back to the parent’s loop', async () => {
		const slot = {
			held: false,
			release: vi.fn(),
			reacquire: vi.fn(async () => {
				throw new DOMException('Aborted', 'AbortError');
			})
		};
		await expect(onOwnLane(slot, async () => 'done')).resolves.toBe('done');
		expect(slot.release).toHaveBeenCalled();
	});

	it('runs in the parent’s slot on the parent’s lane', async () => {
		scripted([1]);
		const lent = vi.fn();
		const runInSlot: SlotLender = (fn) => {
			lent();
			return fn();
		};
		await runSubtask({ ...base, backend: openrouter, runInSlot, profile: profile() });
		expect(lent).toHaveBeenCalledTimes(1);
		expect(mocks.withInferenceSlot).not.toHaveBeenCalled();
	});

	it('keeps a thumbnail on its newest image step only', async () => {
		const onStep = vi.fn();
		mocks.runAgentLoop.mockImplementation(async (o: AgentLoopOptions) => {
			for (const id of ['c1', 'c2']) {
				const call = { id, name: 'check_3d', arguments: { path: 'assets/crate.js' } };
				o.onToolStart(call as never);
				o.onToolEnd(call as never, 'Wrote assets/crate.glb.', `data:image/png;base64,${id}`);
			}
			o.onStreamChunk(chunk('done'));
			o.onComplete({ stopReason: 'complete' });
		});
		const res = await runSubtask({ ...base, profile: profile(), onStep });
		expect(res.steps.map((s) => s.thumbDataUrl)).toEqual([undefined, 'data:image/png;base64,c2']);
	});
});
