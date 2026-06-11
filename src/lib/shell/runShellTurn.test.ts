import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopOptions } from '$lib/agent/loop';

const mocks = vi.hoisted(() => ({
	runAgentLoop: vi.fn(),
	withInferenceSlot: vi.fn(),
	updateContextUsage: vi.fn(),
	stripToolCallArtifacts: vi.fn((s: string) => s.replace(/<tc>[\s\S]*?<\/tc>/g, ''))
}));

vi.mock('$lib/agent/loop', () => ({
	runAgentLoop: mocks.runAgentLoop
}));

vi.mock('$lib/agent/inferenceQueue.svelte', () => ({
	withInferenceSlot: mocks.withInferenceSlot
}));

vi.mock('$lib/stores/context.svelte', () => ({
	updateContextUsage: mocks.updateContextUsage
}));

vi.mock('$lib/markdown', () => ({
	stripToolCallArtifacts: mocks.stripToolCallArtifacts
}));

import { runShellTurn, type ShellTurnOptions } from '$lib/shell/runShellTurn';
import type { ChatMessage } from '$lib/api';

const messages: ChatMessage[] = [{ role: 'user', content: 'why is sshd down?' }];

function loopOptions(): AgentLoopOptions {
	return mocks.runAgentLoop.mock.calls[0][0] as AgentLoopOptions;
}

function chunk(content: string) {
	return { delta: { content } } as unknown as Parameters<AgentLoopOptions['onStreamChunk']>[0];
}

beforeEach(() => {
	mocks.runAgentLoop.mockReset();
	mocks.withInferenceSlot.mockReset();
	mocks.updateContextUsage.mockReset();
	mocks.stripToolCallArtifacts.mockClear();
	// Default pass-through gate: admit immediately and run the turn.
	mocks.withInferenceSlot.mockImplementation(
		async (opts: { onAdmitted?: () => void }, fn: () => Promise<unknown>) => {
			opts.onAdmitted?.();
			return fn();
		}
	);
});

describe('runShellTurn', () => {
	it('returns the assembled streamed text, stripped and trimmed', async () => {
		const deltas: string[] = [];
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onStreamChunk(chunk('sshd is '));
			opts.onStreamChunk(chunk('masked.<tc>{"name":"x"}</tc> \n'));
			opts.onComplete();
		});

		const result = await runShellTurn({
			messages,
			contextSize: 8192,
			onAssistantDelta: (full) => deltas.push(full)
		});

		expect(result.finalText).toBe('sshd is masked.');
		// Each delta reports the full accumulated text so far.
		expect(deltas).toEqual(['sshd is ', 'sshd is masked.<tc>{"name":"x"}</tc> \n']);
		expect(mocks.stripToolCallArtifacts).toHaveBeenCalled();
	});

	it('acquires the inference slot as the shell consumer and reports admission', async () => {
		const ctrl = new AbortController();
		const onTicket = vi.fn();
		const onAdmitted = vi.fn();
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runShellTurn({
			messages,
			contextSize: 4096,
			signal: ctrl.signal,
			onTicket,
			onAdmitted
		});

		expect(mocks.withInferenceSlot).toHaveBeenCalledTimes(1);
		const slotOpts = mocks.withInferenceSlot.mock.calls[0][0] as {
			consumer: string;
			signal?: AbortSignal;
			onTicket?: unknown;
			onAdmitted?: unknown;
		};
		expect(slotOpts.consumer).toBe('shell');
		expect(slotOpts.signal).toBe(ctrl.signal);
		expect(slotOpts.onTicket).toBe(onTicket);
		expect(onAdmitted).toHaveBeenCalledTimes(1);
	});

	it('builds shell-mode loop options with sane defaults', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runShellTurn({ messages, contextSize: 8192 });

		const opts = loopOptions();
		expect(opts.messages).toBe(messages);
		expect(opts.workingDir).toBeNull();
		expect(opts.shellMode).toBe(true);
		expect(opts.shellAllowWrite).toBe(false);
		expect(opts.shellCwd).toBeNull();
		expect(opts.maxIterations).toBe(12);
		expect(opts.deepResearch).toBe(false);
		expect(opts.expectsFileOutput).toBe(false);
		expect(opts.visionSupported).toBe(true);
	});

	it('forwards explicit allowWrite, cwd, maxIterations, and signal', async () => {
		const ctrl = new AbortController();
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runShellTurn({
			messages,
			contextSize: 8192,
			maxIterations: 3,
			allowWrite: true,
			cwd: '/home/tim',
			visionSupported: false,
			signal: ctrl.signal
		});

		const opts = loopOptions();
		expect(opts.shellAllowWrite).toBe(true);
		expect(opts.shellCwd).toBe('/home/tim');
		expect(opts.maxIterations).toBe(3);
		expect(opts.visionSupported).toBe(false);
		expect(opts.signal).toBe(ctrl.signal);
	});

	it('wires usage updates into the context store with the turn context size', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onUsageUpdate?.({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
			opts.onComplete();
		});

		await runShellTurn({ messages, contextSize: 8192 });

		expect(mocks.updateContextUsage).toHaveBeenCalledWith(
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			8192
		);
	});

	it('forwards tool, stats, and context-managed callbacks', async () => {
		const onToolStart = vi.fn();
		const onToolEnd = vi.fn();
		const onCallStats = vi.fn();
		const onContextManaged = vi.fn();
		const call = { id: '1', name: 'fs_read_text', arguments: { path: '/etc/hosts' } };

		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onToolStart(call as Parameters<AgentLoopOptions['onToolStart']>[0]);
			opts.onToolEnd(
				call as Parameters<AgentLoopOptions['onToolEnd']>[0],
				'file contents',
				undefined,
				[]
			);
			opts.onCallStats?.({ durationMs: 1200, completionTokens: 42 });
			opts.onContextManaged?.({ kind: 'trim' } as unknown as Parameters<
				NonNullable<AgentLoopOptions['onContextManaged']>
			>[0]);
			opts.onComplete();
		});

		await runShellTurn({
			messages,
			contextSize: 8192,
			onToolStart,
			onToolEnd,
			onCallStats,
			onContextManaged
		} as ShellTurnOptions);

		expect(onToolStart).toHaveBeenCalledWith(call);
		expect(onToolEnd).toHaveBeenCalledWith(call, 'file contents', undefined, []);
		expect(onCallStats).toHaveBeenCalledWith({ durationMs: 1200, completionTokens: 42 });
		expect(onContextManaged).toHaveBeenCalledWith({ kind: 'trim' });
	});

	it('rethrows an inference error reported by the loop after it settles', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onStreamChunk(chunk('partial '));
			opts.onError(new Error('llama-server returned 500'));
		});

		await expect(runShellTurn({ messages, contextSize: 8192 })).rejects.toThrow(
			'llama-server returned 500'
		);
	});

	it('propagates an abort thrown mid-stream while the caller keeps the partial deltas', async () => {
		const deltas: string[] = [];
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onStreamChunk(chunk('checking journal'));
			throw new DOMException('Aborted', 'AbortError');
		});

		// The shell store catches this rejection and shows "Cancelled."; the
		// partial text it already received via onAssistantDelta is what
		// remains on screen as streamingContent until the catch clears it.
		await expect(
			runShellTurn({
				messages,
				contextSize: 8192,
				onAssistantDelta: (full) => deltas.push(full)
			})
		).rejects.toMatchObject({ name: 'AbortError' });

		expect(deltas).toEqual(['checking journal']);
	});
});
