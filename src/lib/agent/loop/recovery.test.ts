import { describe, it, expect, vi } from 'vitest';
import type { ChatCompletionResponse, ChatMessage } from '#lib/api.ts';
import { ApiError } from '#lib/api.ts';
import { LoopState, type LoopContext } from './context';
import {
	MAX_FILE_WRITE_RETRIES,
	MAX_LENGTH_CONTINUE_RETRIES,
	MAX_TRUNCATION_RETRIES,
	NUDGE_NOTE,
	NudgeState
} from './nudges';
import {
	handleRejectedToolCall,
	pushNudge,
	tryContinueOnLength,
	tryDegradedOutput,
	tryFileWriteRecovery,
	tryMalformedToolCall,
	tryNarrateRecovery
} from './recovery';

vi.mock('#lib/debug-log.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debug-log.ts')>()),
	logDebug: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn().mockRejectedValue(new Error('not available'))
}));

type Fixture = {
	ctx: LoopContext;
	added: ChatMessage[];
	errors: unknown[];
	completed: { count: number };
};

function fixture(over: Partial<LoopContext> = {}): Fixture {
	const added: ChatMessage[] = [];
	const errors: unknown[] = [];
	const completed = { count: 0 };
	const ctx = {
		messages: [{ role: 'user', content: 'go' }],
		maxResponseTokens: 4096,
		expectsFileOutput: false,
		options: {
			onMessageAdded: (m: ChatMessage) => added.push(m),
			onError: (e: unknown) => errors.push(e),
			onComplete: () => completed.count++
		},
		...over
	} as unknown as LoopContext;
	return { ctx, added, errors, completed };
}

function res(content: string | null, finish_reason = 'stop'): ChatCompletionResponse {
	return { content, finish_reason } as ChatCompletionResponse;
}

function usedTools(): LoopState {
	const s = new LoopState();
	s.usedTools = true;
	return s;
}

describe('pushNudge', () => {
	it('echoes the assistant content and appends the nudge with the automatic-check note', () => {
		const { ctx, added } = fixture();
		expect(pushNudge(ctx, res('hello'), 'Do it.')).toBe('continue');
		expect(added).toEqual([
			{ role: 'assistant', content: 'hello' },
			{ role: 'user', content: `Do it.\n\n${NUDGE_NOTE}` }
		]);
		expect(ctx.messages.slice(-2)).toEqual(added);
	});

	it('echoes an empty string for null content', () => {
		const { ctx, added } = fixture();
		pushNudge(ctx, res(null), 'x');
		expect(added[0]).toEqual({ role: 'assistant', content: '' });
	});

	it('strips tool-call artifacts and think blocks when asked', () => {
		const { ctx, added } = fixture();
		pushNudge(ctx, res('<think>r</think>  hi <tool_call>{bad</tool_call>'), 'x', true, true);
		expect(added[0].content).toBe('hi ');
	});
});

describe('tryContinueOnLength', () => {
	it('returns null unless the finish reason is length', () => {
		const { ctx, added } = fixture();
		expect(tryContinueOnLength(ctx, usedTools(), new NudgeState(), res('x'), 1)).toBeNull();
		expect(added).toEqual([]);
	});

	it('resumes a cut-off answer with a bare "Continue." and a think-stripped echo', () => {
		const { ctx, added } = fixture();
		const out = tryContinueOnLength(
			ctx,
			new LoopState(),
			new NudgeState(),
			res('<think>plan</think>\nPartial answ', 'length'),
			1
		);
		expect(out).toBe('continue');
		expect(added).toEqual([
			{ role: 'assistant', content: 'Partial answ' },
			{ role: 'user', content: 'Continue.' }
		]);
	});

	it('resumes after tools even when there is no answer content yet', () => {
		const { ctx, added } = fixture();
		const nudges = new NudgeState();
		const out = tryContinueOnLength(ctx, usedTools(), nudges, res('<think>x</think>', 'length'), 1);
		expect(out).toBe('continue');
		expect(added.at(-1)).toEqual({ role: 'user', content: 'Continue.' });
		// The bounded reasoning-overrun budget is untouched on this path.
		expect(nudges.lengthContinueRetryCount).toBe(0);
	});

	it('asks for the answer directly when cut off mid-reasoning, without an echo', () => {
		const { ctx, added } = fixture();
		const nudges = new NudgeState();
		const out = tryContinueOnLength(
			ctx,
			new LoopState(),
			nudges,
			res('<think>long reasoning</think>', 'length'),
			1
		);
		expect(out).toBe('continue');
		expect(added).toHaveLength(1);
		expect(added[0].role).toBe('user');
		expect(added[0].content).toContain('4096-token limit while you were still thinking');
		expect(added[0].content).toContain(NUDGE_NOTE);
		expect(nudges.lengthContinueRetryCount).toBe(1);
	});

	it('returns null once the reasoning-overrun retries are spent', () => {
		const { ctx } = fixture();
		const nudges = new NudgeState();
		for (let i = 0; i < MAX_LENGTH_CONTINUE_RETRIES; i++) {
			expect(tryContinueOnLength(ctx, new LoopState(), nudges, res(null, 'length'), i)).toBe(
				'continue'
			);
		}
		const before = ctx.messages.length;
		expect(tryContinueOnLength(ctx, new LoopState(), nudges, res(null, 'length'), 9)).toBeNull();
		expect(ctx.messages).toHaveLength(before);
	});
});

describe('tryMalformedToolCall', () => {
	it.each(['text <tool_call>{"name": broken', 'text <function=fs_write_text><parameter=path>'])(
		'nudges after tools when content holds a tool-call fragment: %s',
		(content) => {
			const { ctx, added } = fixture();
			expect(tryMalformedToolCall(ctx, usedTools(), res(content), 1)).toBe('continue');
			expect(added[0].content).not.toMatch(/<tool_call>|<function=/);
			expect(added[1].content).toContain('malformed or incomplete tool call');
		}
	);

	it.each<[string, LoopState, string | null]>([
		['no tools used yet', new LoopState(), '<tool_call>{bad'],
		['null content', usedTools(), null],
		['plain prose', usedTools(), 'All done.']
	])('returns null for %s', (_label, state, content) => {
		const { ctx, added } = fixture();
		expect(tryMalformedToolCall(ctx, state, res(content), 1)).toBeNull();
		expect(added).toEqual([]);
	});
});

describe('tryDegradedOutput', () => {
	it.each([
		'https://example.com/page',
		'  http://x.y/z  ',
		'fetch_url: https://example.com',
		'web_search("cats")',
		'fs_write_text = {"path": "a"}',
		'research_url(https://x)'
	])('breaks on %j after tools', (content) => {
		expect(tryDegradedOutput(usedTools(), res(content), 1)).toBe('break');
	});

	it.each<[string, LoopState, string | null]>([
		['before any tool use', new LoopState(), 'https://example.com'],
		['null content', usedTools(), null],
		['whitespace', usedTools(), '   '],
		['URL inside prose', usedTools(), 'See https://example.com for details'],
		['two URLs', usedTools(), 'https://a.com https://b.com'],
		['tool name in prose', usedTools(), 'I used fetch_url to read it.'],
		['unknown tool name', usedTools(), 'run_python(print(1))']
	])('returns null for %s', (_label, state, content) => {
		expect(tryDegradedOutput(state, res(content), 1)).toBeNull();
	});
});

describe('tryNarrateRecovery', () => {
	it('returns null when not armed', () => {
		const { ctx, added } = fixture();
		expect(tryNarrateRecovery(ctx, new NudgeState(), res('I will fetch it.'), 1)).toBeNull();
		expect(added).toEqual([]);
	});

	it('forces the action and disarms when armed', () => {
		const { ctx, added } = fixture();
		const nudges = new NudgeState();
		nudges.armNarrateRecovery();
		expect(tryNarrateRecovery(ctx, nudges, res('Let me fetch these pages.'), 1)).toBe('continue');
		expect(nudges.needsNarrateRecovery()).toBe(false);
		expect(added[0]).toEqual({ role: 'assistant', content: 'Let me fetch these pages.' });
		expect(added[1].content).toContain('did not actually emit a tool_calls block');
	});

	// Staying armed is safe: NudgeState lives for one turn (runLoop makes a
	// new one), and a clarifying question ends that turn, so the flag never
	// reaches the user's reply.
	it('lets a clarifying question through and stays armed', () => {
		const { ctx, added } = fixture();
		const nudges = new NudgeState();
		nudges.armNarrateRecovery();
		expect(tryNarrateRecovery(ctx, nudges, res('Which file do you mean?'), 1)).toBeNull();
		expect(added).toEqual([]);
		expect(nudges.needsNarrateRecovery()).toBe(true);
	});
});

describe('handleRejectedToolCall', () => {
	it('asks for the call again while retries remain', () => {
		const { ctx, added, errors, completed } = fixture();
		const nudges = new NudgeState();
		const out = handleRejectedToolCall(
			ctx,
			nudges,
			res('<tool_call>{"name":"fs_write_text","arguments":{"content":"abc', 'length'),
			'truncated tool call arguments',
			1
		);
		expect(out).toBe('continue');
		expect(nudges.truncationRetryCount).toBe(1);
		expect(added[0].content).not.toContain('<tool_call>');
		expect(added[1].content).toContain(
			'Your last tool call was not run: truncated tool call arguments.'
		);
		expect(errors).toEqual([]);
		expect(completed.count).toBe(0);
	});

	it('completes with an actionable error once retries are spent', () => {
		const { ctx, errors, completed } = fixture({
			expectsFileOutput: true,
			maxResponseTokens: 16384
		});
		const nudges = new NudgeState();
		for (let i = 0; i < MAX_TRUNCATION_RETRIES; i++) nudges.consumeTruncationRetry();
		const before = ctx.messages.length;

		const out = handleRejectedToolCall(ctx, nudges, res('', 'length'), 'why', 3);

		expect(out).toBe('complete');
		expect(ctx.messages).toHaveLength(before);
		expect(completed.count).toBe(1);
		expect(errors).toHaveLength(1);
		const err = errors[0] as Error;
		expect(err).toBeInstanceOf(ApiError);
		expect(err.message).toContain('(why)');
		expect(err.message).toContain(`within ${MAX_TRUNCATION_RETRIES} attempts`);
		expect(err.message).toContain('16384-token ceiling');
		expect(err.message).toContain('Max response tokens (file writes)');
	});

	it('names the general response setting when no file is expected', () => {
		const { ctx, errors } = fixture();
		const nudges = new NudgeState();
		for (let i = 0; i < MAX_TRUNCATION_RETRIES; i++) nudges.consumeTruncationRetry();
		handleRejectedToolCall(ctx, nudges, res('', 'length'), 'why', 3);
		expect((errors[0] as Error).message).toContain('Response Length → Max response tokens,');
	});

	it('does not blame the token ceiling when the response was not cut off', () => {
		const { ctx, errors, completed } = fixture();
		const nudges = new NudgeState();
		for (let i = 0; i < MAX_TRUNCATION_RETRIES; i++) nudges.consumeTruncationRetry();
		const reason = "duplicate parameter 'path' in call to 'fs_write_text' — ambiguous";

		expect(handleRejectedToolCall(ctx, nudges, res('', 'tool_calls'), reason, 3)).toBe('complete');

		expect(completed.count).toBe(1);
		const message = (errors[0] as Error).message;
		expect(message).toContain(`could not be run (${reason})`);
		expect(message).not.toContain('token ceiling');
		expect(message).not.toContain('Response Length');
	});
});

describe('tryFileWriteRecovery', () => {
	it('returns null when the turn does not expect a file', () => {
		const { ctx, added } = fixture();
		expect(tryFileWriteRecovery(ctx, new NudgeState(), res('Here is the report.'), 1)).toBeNull();
		expect(added).toEqual([]);
	});

	it('nudges for the write and arms narrate recovery', () => {
		const { ctx, added } = fixture({ expectsFileOutput: true });
		const nudges = new NudgeState();
		expect(tryFileWriteRecovery(ctx, nudges, res('I have written report.pdf.'), 1)).toBe(
			'continue'
		);
		expect(nudges.fileWriteRetryCount).toBe(1);
		expect(nudges.needsNarrateRecovery()).toBe(true);
		expect(added[1].content).toContain('You have not emitted an fs_write_* tool call');
	});

	it('returns null when a file was already written', () => {
		const { ctx } = fixture({ expectsFileOutput: true });
		const nudges = new NudgeState();
		nudges.markFileWritten();
		expect(tryFileWriteRecovery(ctx, nudges, res('Done.'), 1)).toBeNull();
	});

	it('returns null for a clarifying question', () => {
		const { ctx } = fixture({ expectsFileOutput: true });
		const nudges = new NudgeState();
		expect(
			tryFileWriteRecovery(ctx, nudges, res('Which sections should I include?'), 1)
		).toBeNull();
		expect(nudges.fileWriteRetryCount).toBe(0);
		expect(nudges.needsNarrateRecovery()).toBe(false);
	});

	it('stops after the retry budget', () => {
		const { ctx } = fixture({ expectsFileOutput: true });
		const nudges = new NudgeState();
		for (let i = 0; i < MAX_FILE_WRITE_RETRIES; i++) {
			expect(tryFileWriteRecovery(ctx, nudges, res('Done.'), i)).toBe('continue');
		}
		expect(tryFileWriteRecovery(ctx, nudges, res('Done.'), 9)).toBeNull();
	});
});
