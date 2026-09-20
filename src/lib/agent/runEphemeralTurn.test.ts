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
	stripToolCallArtifacts: (s: string) => s,
	finalizeStreamText: (raw: string) => ({ content: raw.trim(), citedUrls: [] })
}));

import { runEphemeralTurn, ambientContextNote } from '$lib/agent/runEphemeralTurn';

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

/**
 * A custom systemPrompt REPLACES buildSystemPrompt, which is the only place
 * the working directory is stated — so every job pipeline ran without the
 * model knowing where it was. A real planning run tried `fs_list_dir /` and
 * got "path escapes working directory" back.
 */
describe('ambientContextNote', () => {
	it('states the directory and how paths resolve', () => {
		const note = ambientContextNote({ workingDir: '/home/tim/Projects/game' });
		expect(note).toContain('/home/tim/Projects/game');
		expect(note).toContain('resolves against it');
		expect(note).toContain('`.` is this directory');
	});

	it('says what is refused, which is the mistake it exists to prevent', () => {
		const note = ambientContextNote({ workingDir: '/repo' });
		// Matches resolve_in_workdir: absolute is allowed only inside, `..` never.
		expect(note).toContain('only if it points INSIDE');
		expect(note).toContain('`..`');
		expect(note).toContain('refused');
	});

	it('always carries the date, with the cutoff caveat', () => {
		// A planning run reasoned about "the current stable release" of a crate
		// with no idea what today is.
		for (const wd of ['/repo', null]) {
			const note = ambientContextNote({ workingDir: wd });
			expect(note).toContain("Today's date is");
			expect(note).toContain('out of date');
		}
	});

	it('omits the filesystem block with no working directory', () => {
		const note = ambientContextNote({ workingDir: null });
		expect(note).not.toContain('WORKING DIRECTORY');
	});

	it('states a write root when the turn is confined to one', () => {
		const note = ambientContextNote({ workingDir: '/repo', writeRoot: 'plan/x/' });
		expect(note).toContain('only WRITE inside');
		expect(note).toContain('plan/x/');
		// Stricter than reads: isUnderWriteRoot rejects any absolute path.
		expect(note).toContain('an absolute one is refused even if it points inside');
	});

	it('omits the write-root line when the turn has none', () => {
		const note = ambientContextNote({ workingDir: '/repo', writeRoot: null });
		expect(note).not.toContain('only WRITE inside');
	});

	it('starts with a blank line so it cannot run into the prompt above it', () => {
		expect(ambientContextNote({ workingDir: '/repo' }).startsWith('\n\n')).toBe(true);
	});
});

describe('runEphemeralTurn — a custom prompt still learns where it is', () => {
	it('appends the working directory to a caller-supplied system prompt', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'write the plan',
			systemPrompt: 'You are writing ONE file of an approved plan.',
			workingDir: '/home/tim/Projects/game',
			contextSize: 8192
		});

		const sys = captureOptions().messages[0];
		// The pipeline's own contract is still first and intact...
		expect(sys.content).toContain('You are writing ONE file of an approved plan.');
		// ...and the model now knows where it is.
		expect(sys.content).toContain('/home/tim/Projects/game');
		expect(sys.content).toContain('WORKING DIRECTORY');
	});

	it('still dates a custom prompt with no working directory', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'x',
			systemPrompt: 'Just this.',
			workingDir: null,
			contextSize: 8192
		});

		const sys = String(captureOptions().messages[0].content);
		// The date is not a filesystem fact, so it is not gated on a workdir.
		expect(sys).toContain('Just this.');
		expect(sys).toContain("Today's date is");
		expect(sys).not.toContain('WORKING DIRECTORY');
	});

	it('tells a write-confined turn where it may write', async () => {
		mocks.runAgentLoop.mockImplementationOnce(async (opts: AgentLoopOptions) => {
			opts.onComplete();
		});

		await runEphemeralTurn({
			userMessage: 'write phase 01',
			systemPrompt: 'You are writing ONE file of an approved plan.',
			workingDir: '/repo',
			writeRoot: 'plan/x/',
			contextSize: 8192
		});

		expect(String(captureOptions().messages[0].content)).toContain('only WRITE inside `plan/x/`');
	});
});
