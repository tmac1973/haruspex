import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '#lib/agent/loop.ts';
import type { ChatMessage } from '#lib/api.ts';

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
	resolveBackendDescriptor: () => ({ contextSize: 16384 })
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({
		codeMaxIterations: 33,
		codeAutoApprove: true,
		maxResponseTokensFileWrite: 12345,
		codeRunCommandTimeoutSecs: 30,
		imageBackendKind: 'none',
		customSystemPrompt: ''
	})
}));

import { collectTurnMessages, runCodeTurn, type CodeTurnOptions } from '#lib/code/runCodeTurn.ts';

function loopOptions(): AgentLoopOptions {
	return mocks.runAgentLoop.mock.calls[0][0] as AgentLoopOptions;
}

function chunk(content: string) {
	return { delta: { content } } as unknown as Parameters<AgentLoopOptions['onStreamChunk']>[0];
}

function opts(over: Partial<CodeTurnOptions> = {}): CodeTurnOptions {
	return {
		sessionId: 's1',
		root: '/proj',
		thread: [{ role: 'user', content: 'fix the test' }],
		backend: null,
		effort: null,
		signal: new AbortController().signal,
		takeSteering: () => [],
		...over
	};
}

const call = (id: string): ChatMessage => ({
	role: 'assistant',
	content: '',
	tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: '{}' } }]
});
const result = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: 'ok' });

beforeEach(() => {
	mocks.runAgentLoop.mockReset();
	mocks.withInferenceSlot
		.mockReset()
		.mockImplementation(async (o: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
			o.onAdmitted?.();
			return fn();
		});
	mocks.shellProject.mockReset().mockResolvedValue({ root: null, agentsMd: null });
	mocks.prepareTurnSkills.mockReset().mockResolvedValue({ catalog: [], projectRoot: null });
});

describe('runCodeTurn', () => {
	it('runs the code profile in the project folder', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => o.onComplete());
		const backend = { baseUrl: 'http://remote', modelId: 'm' };
		await runCodeTurn(opts({ backend, effort: 'high' }));
		const o = loopOptions();
		expect(o).toMatchObject({
			codeMode: true,
			shellMode: false,
			workingDir: '/proj',
			codeSessionId: 's1',
			interactive: true,
			backend,
			reasoningEffort: 'high',
			maxIterations: 33,
			maxResponseTokens: 12345,
			codeAutoApprove: true,
			contextSize: 16384
		});
		expect(mocks.withInferenceSlot.mock.calls[0][0]).toMatchObject({ consumer: 'code', backend });
		// writeRoot is relative to the working dir; the absolute root refused every write.
		expect(o.writeRoot ?? null).toBeNull();
	});

	it('leads with the coding prompt for the folder', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => o.onComplete());
		await runCodeTurn(opts());
		const [system, user] = loopOptions().messages;
		expect(system.role).toBe('system');
		expect(String(system.content)).toContain('Project folder: /proj');
		expect(user).toEqual({ role: 'user', content: 'fix the test' });
	});

	it('follows the global backend and effort when the session has none', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => o.onComplete());
		await runCodeTurn(opts());
		expect(loopOptions().backend).toBeUndefined();
		expect(loopOptions().reasoningEffort).toBeNull();
	});

	it('returns the tool pairs and the answer', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.messages.push(call('c1'), result('c1'));
			o.messages.push({ role: 'user', content: 'nudge' });
			o.onStreamChunk(chunk('Fixed.'));
			o.onComplete({ stopReason: 'max_iterations' });
		});
		const res = await runCodeTurn(opts());
		expect(res.outcome).toBe('complete');
		expect(res.stopReason).toBe('max_iterations');
		expect(res.added).toEqual([call('c1'), result('c1'), { role: 'assistant', content: 'Fixed.' }]);
	});

	it('passes steering through and keeps it in the thread', async () => {
		const queue = ['use pnpm'];
		const onSteering = vi.fn();
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onStreamChunk(chunk('Running npm. '));
			const texts = o.takeSteering!();
			o.messages.push({ role: 'assistant', content: 'Running npm.' });
			for (const t of texts) o.messages.push({ role: 'user', content: t });
			o.onSteering!(texts);
			o.onStreamChunk(chunk('Switched to pnpm.'));
			o.onComplete();
		});
		const res = await runCodeTurn(opts({ takeSteering: () => queue.splice(0), onSteering }));
		expect(onSteering).toHaveBeenCalledWith(['use pnpm']);
		expect(queue).toEqual([]);
		expect(res.added).toEqual([
			{ role: 'assistant', content: 'Running npm.' },
			{ role: 'user', content: 'use pnpm' },
			{ role: 'assistant', content: 'Switched to pnpm.' }
		]);
	});

	it('hands back steering the model never saw', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) =>
			o.onComplete({ stopReason: 'forced_stop', undeliveredSteering: ['also lint'] })
		);
		const res = await runCodeTurn(opts());
		expect(res.undeliveredSteering).toEqual(['also lint']);
	});

	it('returns what a stopped turn finished, without throwing', async () => {
		const abort = new AbortController();
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.messages.push(call('c1'), result('c1'), call('c2'));
			o.onStreamChunk(chunk('Half an ans'));
			abort.abort();
			o.onComplete({ stopReason: 'complete', aborted: true, undeliveredSteering: ['wait'] });
			throw new DOMException('Aborted', 'AbortError');
		});
		const res = await runCodeTurn(opts({ signal: abort.signal }));
		expect(res.outcome).toBe('aborted');
		expect(res.undeliveredSteering).toEqual(['wait']);
		expect(res.added).toEqual([
			call('c1'),
			result('c1'),
			{ role: 'assistant', content: 'Half an ans' }
		]);
	});

	it('reports a failed turn in its result', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => {
			o.onError(new Error('server went away'));
		});
		const res = await runCodeTurn(opts());
		expect(res).toMatchObject({ outcome: 'error', error: 'server went away', added: [] });
	});

	it('reports the trusted project it used', async () => {
		const agentsMd = { files: ['AGENTS.md'], text: 'rules', truncated: false, totalBytes: 5 };
		mocks.shellProject.mockResolvedValueOnce({ root: '/proj', agentsMd });
		mocks.runAgentLoop.mockImplementationOnce(async (o: AgentLoopOptions) => o.onComplete());
		const onProject = vi.fn();
		await runCodeTurn(opts({ onProject }));
		expect(mocks.shellProject).toHaveBeenCalledWith('/proj');
		expect(onProject).toHaveBeenCalledWith({ root: '/proj', agentsMd });
		expect(mocks.prepareTurnSkills).toHaveBeenCalledWith(
			expect.objectContaining({ projectRoot: '/proj', codeMode: true })
		);
	});
});

describe('collectTurnMessages', () => {
	it('drops a call whose results are not all in, with its partial results', () => {
		const both: ChatMessage = {
			role: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
				{ id: 'b', type: 'function', function: { name: 'x', arguments: '{}' } }
			]
		};
		expect(collectTurnMessages([both, result('a')], new Set(), null)).toEqual([]);
	});

	it('drops loop nudges and appends the answer', () => {
		const nudge: ChatMessage = { role: 'user', content: 'Continue.' };
		const echo: ChatMessage = { role: 'assistant', content: 'cut off' };
		expect(collectTurnMessages([echo, nudge], new Set(), 'done')).toEqual([
			{ role: 'assistant', content: 'done' }
		]);
	});
});
