import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '$lib/agent/loop';

const mocks = vi.hoisted(() => ({
	runAgentLoop: vi.fn()
}));

vi.mock('$lib/agent/loop', () => ({
	runAgentLoop: mocks.runAgentLoop
}));

vi.mock('$lib/agent/system-prompt', () => ({
	buildSystemPrompt: (workingDir: string | null) => ({
		role: 'system' as const,
		content: workingDir ? `sys prompt for ${workingDir}` : 'sys prompt'
	}),
	looksLikeFileOutputRequest: (s: string) => /pdf/i.test(s)
}));

vi.mock('$lib/markdown', () => ({
	processCitations: (text: string) => ({ content: text, citedUrls: [] }),
	stripToolCallArtifacts: (s: string) => s
}));

import { runEphemeralTurn } from '$lib/agent/runEphemeralTurn';

beforeEach(() => {
	mocks.runAgentLoop.mockReset();
});

function captureOptions(): AgentLoopOptions {
	return mocks.runAgentLoop.mock.calls[0][0] as AgentLoopOptions;
}

describe('runEphemeralTurn', () => {
	it('builds messages with system prompt + user message', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'do the thing',
			workingDir: '/tmp/work',
			contextSize: 8192
		});

		const opts = captureOptions();
		expect(opts.messages).toHaveLength(2);
		expect(opts.messages[0]).toEqual({ role: 'system', content: 'sys prompt for /tmp/work' });
		expect(opts.messages[1]).toEqual({ role: 'user', content: 'do the thing' });
		expect(opts.workingDir).toBe('/tmp/work');
		expect(opts.contextSize).toBe(8192);
	});

	it('sets expectsFileOutput when the prompt mentions a file format and workdir is set', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'make me a pdf',
			workingDir: '/tmp/work',
			contextSize: 8192
		});

		expect(captureOptions().expectsFileOutput).toBe(true);
	});

	it('does not set expectsFileOutput when no workdir', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'make me a pdf',
			workingDir: null,
			contextSize: 8192
		});

		expect(captureOptions().expectsFileOutput).toBe(false);
	});

	it('accumulates streaming content and reports it via onAssistantDelta', async () => {
		const deltas: string[] = [];
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onStreamChunk({ delta: { content: 'hello ' } } as unknown as Parameters<
				typeof opts.onStreamChunk
			>[0]);
			opts.onStreamChunk({ delta: { content: 'world' } } as unknown as Parameters<
				typeof opts.onStreamChunk
			>[0]);
			opts.onComplete();
		});

		const { finalText } = await runEphemeralTurn({
			userMessage: 'hi',
			workingDir: null,
			contextSize: 4096,
			onAssistantDelta: (full) => deltas.push(full)
		});

		expect(deltas).toEqual(['hello ', 'hello world']);
		expect(finalText).toBe('hello world');
	});

	it('wraps reasoning_content with <think> tags', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onStreamChunk({
				delta: { reasoning_content: 'thinking…' }
			} as unknown as Parameters<typeof opts.onStreamChunk>[0]);
			opts.onStreamChunk({ delta: { content: 'answer' } } as unknown as Parameters<
				typeof opts.onStreamChunk
			>[0]);
			opts.onComplete();
		});

		const { finalText } = await runEphemeralTurn({
			userMessage: 'q',
			workingDir: null,
			contextSize: 4096
		});

		expect(finalText).toContain('<think>thinking…</think>');
		expect(finalText).toContain('answer');
	});

	it('rethrows errors reported by the loop', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onError(new Error('loop broke'));
		});

		await expect(
			runEphemeralTurn({ userMessage: 'q', workingDir: null, contextSize: 4096 })
		).rejects.toThrow('loop broke');
	});

	it('forwards deep-research and signal', async () => {
		const ctrl = new AbortController();
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'q',
			workingDir: '/tmp',
			contextSize: 4096,
			deepResearch: true,
			signal: ctrl.signal
		});

		const opts = captureOptions();
		expect(opts.deepResearch).toBe(true);
		expect(opts.signal).toBe(ctrl.signal);
		expect(opts.maxIterations).toBe(25);
	});
});
