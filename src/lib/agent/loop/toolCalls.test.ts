import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ChatMessage } from '#lib/api.ts';
import type { ResolvedToolCall } from '#lib/agent/parser.ts';
import type { LoopContext } from './context';

interface Output {
	result: string;
	heroImage?: string;
	thumbDataUrl?: string;
}

const tools = vi.hoisted(() => ({
	executeTool: vi.fn(),
	coerceCallArguments: vi.fn((_name: string, args: Record<string, unknown>) => args)
}));
vi.mock('#lib/agent/tools/index.ts', () => tools);

const lane = vi.hoisted(() => ({ limit: 1 as number | null }));
vi.mock('#lib/agent/inferenceQueue.svelte.ts', () => ({
	laneConcurrency: () => lane.limit,
	createSlotLender: () => (fn: () => Promise<unknown>) => fn()
}));

const dbg = vi.hoisted(() => ({
	lines: [] as Array<[string, Record<string, unknown> | undefined]>,
	verbose: false
}));
vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: (_cat: string, msg: string, data?: Record<string, unknown>) =>
		dbg.lines.push([msg, data]),
	isVerbosePayloads: () => dbg.verbose
}));

import { executeToolCalls } from './toolCalls';
import { NudgeState } from './nudges';

/** What happened, in order: `start:<id>`, `end:<id>`, `added:<role>`. */
let events: string[];
let progress: Array<[string, string]>;
let started: ResolvedToolCall[];

function makeCtx(over: Partial<LoopContext['options']> = {}, signal?: AbortSignal): LoopContext {
	return {
		messages: [] as ChatMessage[],
		signal,
		workingDir: '/work',
		pendingImages: [],
		options: {
			onToolStart: (call: ResolvedToolCall) => {
				started.push(call);
				events.push(`start:${call.id}`);
			},
			onToolEnd: (call: ResolvedToolCall) => events.push(`end:${call.id}`),
			onToolProgress: (call: ResolvedToolCall, status: string) => progress.push([call.id, status]),
			onMessageAdded: (m: ChatMessage) => events.push(`added:${m.role}`),
			...over
		}
	} as unknown as LoopContext;
}

let n = 0;
function call(name: string, args: Record<string, unknown> = {}): ResolvedToolCall {
	return { id: `c${++n}`, name, arguments: args };
}

/** Answer each tool call with `answer(call)`, after `delay(call)` ms. */
function toolsAnswer(
	answer: (c: ResolvedToolCall) => Output | Promise<Output>,
	delay: (c: ResolvedToolCall) => number = () => 0
) {
	tools.executeTool.mockImplementation(
		async (
			name: string,
			args: Record<string, unknown>,
			tctx: { onProgress: (s: string) => void }
		) => {
			const c = { id: '', name, arguments: args };
			const ms = delay(c);
			if (ms) await new Promise((r) => setTimeout(r, ms));
			tctx.onProgress?.(`working on ${name}`);
			return answer(c);
		}
	);
}

function toolMessages(ctx: LoopContext): Array<{ id: string; content: string }> {
	return ctx.messages
		.filter((m) => m.role === 'tool')
		.map((m) => ({ id: (m as { tool_call_id: string }).tool_call_id, content: String(m.content) }));
}

beforeEach(() => {
	events = [];
	progress = [];
	started = [];
	n = 0;
	lane.limit = 1;
	dbg.lines = [];
	dbg.verbose = false;
	tools.executeTool.mockReset();
	tools.coerceCallArguments.mockImplementation((_name, args) => args);
	toolsAnswer((c) => ({ result: `ok ${c.name}` }));
});

describe('executeToolCalls: messages', () => {
	it('appends the assistant tool_calls message, then one tool message per call', async () => {
		const ctx = makeCtx();
		const calls = [call('fs_list_dir', { path: '.' }), call('fs_read_text', { path: 'a' })];
		await executeToolCalls(ctx, new NudgeState(), calls);

		expect(ctx.messages[0]).toEqual({
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					id: 'c1',
					type: 'function',
					function: { name: 'fs_list_dir', arguments: '{"path":"."}' }
				},
				{
					id: 'c2',
					type: 'function',
					function: { name: 'fs_read_text', arguments: '{"path":"a"}' }
				}
			]
		});
		expect(toolMessages(ctx)).toEqual([
			{ id: 'c1', content: 'ok fs_list_dir' },
			{ id: 'c2', content: 'ok fs_read_text' }
		]);
		expect(events.filter((e) => e.startsWith('added'))).toEqual([
			'added:assistant',
			'added:tool',
			'added:tool'
		]);
	});

	it("keeps a streamed round's text, minus reasoning, and echoes reasoning_details", async () => {
		const ctx = makeCtx({ streamToolRounds: true });
		const details = [{ type: 'reasoning.text', text: 'hmm' }];
		const response = {
			content: '<think>private</think>Let me look.',
			reasoning_details: details
		} as unknown as ChatCompletionResponse;
		await executeToolCalls(ctx, new NudgeState(), [call('fs_list_dir')], response);
		expect(ctx.messages[0]).toMatchObject({ content: 'Let me look.', reasoning_details: details });
	});

	it("drops an unstreamed round's text", async () => {
		const ctx = makeCtx();
		const response = { content: 'thinking aloud' } as unknown as ChatCompletionResponse;
		await executeToolCalls(ctx, new NudgeState(), [call('fs_list_dir')], response);
		expect(ctx.messages[0].content).toBe('');
		expect(ctx.messages[0]).not.toHaveProperty('reasoning_details');
	});

	it('shows onToolStart the coerced arguments and runs the tool on the raw ones', async () => {
		tools.coerceCallArguments.mockImplementation((_name, args) => ({
			...args,
			entries: JSON.parse(args.entries as string)
		}));
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [call('save_spec', { entries: '[1,2]' })]);
		expect(started[0].arguments).toEqual({ entries: [1, 2] });
		expect(tools.executeTool.mock.calls[0][1]).toEqual({ entries: '[1,2]' });
	});

	it("forwards a tool's progress with its call", async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [call('run_python', { code: '1' })]);
		expect(progress).toEqual([['c1', 'working on run_python']]);
	});
});

describe('executeToolCalls: debug log', () => {
	const logged = (msg: string) => dbg.lines.find(([m]) => m === msg)?.[1];

	it('logs argument names and the result length, never the content, by default', async () => {
		toolsAnswer(() => ({ result: 'Dear Sam, the password is hunter2' }));
		await executeToolCalls(makeCtx(), new NudgeState(), [
			call('email_send', { body: 'secret body' })
		]);
		expect(logged('tool start: email_send')).toEqual({ args: ['body'] });
		const end = logged('tool end: email_send');
		expect(end?.resultLen).toBe(33);
		expect(JSON.stringify(end)).not.toContain('hunter2');
	});

	it('logs arguments and result whole with verbose payloads on', async () => {
		dbg.verbose = true;
		toolsAnswer(() => ({ result: 'full result' }));
		await executeToolCalls(makeCtx(), new NudgeState(), [call('fs_read_text', { path: 'a' })]);
		expect(logged('tool start: fs_read_text')).toEqual({ args: { path: 'a' } });
		expect(logged('tool end: fs_read_text')?.resultPreview).toBe('full result');
	});
});

describe('executeToolCalls: ordering', () => {
	it('on a serialized lane, runs each call to its end before starting the next', async () => {
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [call('fetch_url'), call('fetch_url')]);
		expect(events.filter((e) => !e.startsWith('added'))).toEqual([
			'start:c1',
			'end:c1',
			'start:c2',
			'end:c2'
		]);
	});

	it('runs read-only calls side by side and still appends results in call order', async () => {
		lane.limit = 4;
		toolsAnswer(
			(c) => ({ result: `page ${c.arguments.url}` }),
			(c) => (c.arguments.url === 'https://slow.test' ? 20 : 1)
		);
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [
			call('fetch_url', { url: 'https://slow.test' }),
			call('fetch_url', { url: 'https://fast.test' })
		]);
		const lifecycle = events.filter((e) => !e.startsWith('added'));
		// Both started before either ended; the fast one ended first.
		expect(lifecycle).toEqual(['start:c1', 'start:c2', 'end:c2', 'end:c1']);
		expect(toolMessages(ctx).map((m) => m.id)).toEqual(['c1', 'c2']);
	});

	it('runs a writing tool alone, between the read-only batches around it', async () => {
		lane.limit = 4;
		toolsAnswer(
			(c) => ({ result: `ok ${c.name}` }),
			() => 2
		);
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [
			call('fs_read_text', { path: 'a' }),
			call('fs_read_text', { path: 'b' }),
			call('fs_write_text', { path: 'c' }),
			call('fs_read_text', { path: 'd' })
		]);
		const lifecycle = events.filter((e) => !e.startsWith('added'));
		const at = (e: string) => lifecycle.indexOf(e);
		expect(at('start:c2')).toBeLessThan(at('end:c1'));
		expect(at('start:c3')).toBeGreaterThan(Math.max(at('end:c1'), at('end:c2')));
		expect(at('start:c4')).toBeGreaterThan(at('end:c3'));
		expect(toolMessages(ctx).map((m) => m.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
	});

	it('rejects with AbortError when cancelled mid-tool, appending no result', async () => {
		const controller = new AbortController();
		tools.executeTool.mockImplementation(() => new Promise(() => {}));
		const ctx = makeCtx({}, controller.signal);
		const run = executeToolCalls(ctx, new NudgeState(), [call('run_command', { command: 'x' })]);
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();
		await expect(run).rejects.toMatchObject({ name: 'AbortError' });
		expect(toolMessages(ctx)).toEqual([]);
		expect(events).toEqual(['added:assistant', 'start:c1']);
	});

	it('does not start a tool once the signal has fired', async () => {
		const controller = new AbortController();
		controller.abort();
		const ctx = makeCtx({}, controller.signal);
		await expect(
			executeToolCalls(ctx, new NudgeState(), [call('fs_list_dir')])
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(started).toEqual([]);
	});

	it('keeps the results before a tool that throws, and rejects', async () => {
		toolsAnswer((c) => {
			if (c.name === 'run_command') throw new Error('spawn failed');
			return { result: 'listed' };
		});
		const ctx = makeCtx();
		await expect(
			executeToolCalls(ctx, new NudgeState(), [call('fs_list_dir'), call('run_command')])
		).rejects.toThrow('spawn failed');
		expect(toolMessages(ctx)).toEqual([{ id: 'c1', content: 'listed' }]);
	});
});

describe('executeToolCalls: web reads', () => {
	it('puts a Source header on a fetched page, with its hero image when there is one', async () => {
		toolsAnswer((c) =>
			c.arguments.url === 'https://a.test'
				? { result: 'body a', heroImage: 'https://a.test/hero.jpg' }
				: { result: 'body b' }
		);
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [
			call('fetch_url', { url: 'https://a.test' }),
			call('research_url', { url: 'https://b.test' })
		]);
		expect(toolMessages(ctx).map((m) => m.content)).toEqual([
			'[Source: https://a.test]\n[Image: https://a.test/hero.jpg]\n\nbody a',
			'[Source: https://b.test]\n\nbody b'
		]);
	});

	it('leaves a failed fetch bare and does not count it as a page read', async () => {
		toolsAnswer(() => ({ result: 'Failed to fetch https://x.test: 403' }));
		const ctx = makeCtx();
		const nudges = new NudgeState();
		const out = await executeToolCalls(ctx, nudges, [call('fetch_url', { url: 'https://x.test' })]);
		expect(toolMessages(ctx)[0].content).toBe('Failed to fetch https://x.test: 403');
		expect(nudges.consumeDiversityNudge()).toBe(0);
		expect(out.allWebReadsBlocked).toBe(true);
	});

	it('counts each successful fetch once per URL', async () => {
		const nudges = new NudgeState();
		await executeToolCalls(makeCtx(), nudges, [
			call('fetch_url', { url: 'https://a.test' }),
			call('fetch_url', { url: 'https://a.test' }),
			call('research_url', { url: 'https://b.test' })
		]);
		expect(nudges.consumeDiversityNudge()).toBe(2);
	});

	it('reports a round of nothing but blocked reads and failed searches', async () => {
		toolsAnswer((c) =>
			c.name === 'web_search'
				? { result: '{"error":"rate limited"}' }
				: { result: 'Paywalled: subscribers only' }
		);
		const out = await executeToolCalls(makeCtx(), new NudgeState(), [
			call('web_search', { query: 'q' }),
			call('fetch_url', { url: 'https://p.test' }),
			call('research_url', { url: 'https://r.test' })
		]);
		expect(out.allWebReadsBlocked).toBe(true);
	});

	it('does not report a round where any call got through', async () => {
		toolsAnswer((c) =>
			c.arguments.url === 'https://ok.test'
				? { result: 'fine' }
				: { result: 'Failed to fetch: 403' }
		);
		const out = await executeToolCalls(makeCtx(), new NudgeState(), [
			call('fetch_url', { url: 'https://blocked.test' }),
			call('fetch_url', { url: 'https://ok.test' })
		]);
		expect(out.allWebReadsBlocked).toBe(false);
	});

	it('does not count a non-web tool, even a failing one, as a blocked read', async () => {
		toolsAnswer((c) =>
			c.name === 'fetch_url' ? { result: 'Failed to fetch: 403' } : { result: '{"error":"nope"}' }
		);
		const out = await executeToolCalls(makeCtx(), new NudgeState(), [
			call('fetch_url', { url: 'https://x.test' }),
			call('fs_read_text', { path: 'a' })
		]);
		expect(out.allWebReadsBlocked).toBe(false);
	});

	it('records a search and an image search for the research nudges', async () => {
		const imageOnly = new NudgeState();
		await executeToolCalls(makeCtx(), imageOnly, [call('image_search', { query: 'cat' })]);
		expect(imageOnly.needsResearchNudge(true, false)).toBe(true);

		const searched = new NudgeState();
		await executeToolCalls(makeCtx(), searched, [
			call('image_search', { query: 'cat' }),
			call('web_search', { query: 'cat' })
		]);
		expect(searched.needsResearchNudge(true, false)).toBe(false);
		expect(searched.needsDiversityNudge(true)).toBe(true);
	});
});

describe('executeToolCalls: nudge bookkeeping', () => {
	it('marks a file written only when a write succeeds', async () => {
		toolsAnswer(() => ({ result: '{"error":"permission denied"}' }));
		const failed = new NudgeState();
		await executeToolCalls(makeCtx(), failed, [call('fs_write_text', { path: 'a' })]);
		expect(failed.needsFileWriteNudge(true)).toBe(true);

		toolsAnswer(() => ({ result: 'Wrote 10 bytes to a' }));
		const wrote = new NudgeState();
		await executeToolCalls(makeCtx(), wrote, [call('fs_write_text', { path: 'a' })]);
		expect(wrote.needsFileWriteNudge(true)).toBe(false);
	});

	it('appends the step-back hint on the third run_python failure in a row', async () => {
		toolsAnswer(() => ({ result: 'Error: NameError' }));
		const ctx = makeCtx();
		await executeToolCalls(ctx, new NudgeState(), [
			call('run_python', { code: 'a' }),
			call('run_python', { code: 'b' }),
			call('run_python', { code: 'c' })
		]);
		const contents = toolMessages(ctx).map((m) => m.content);
		expect(contents[0]).toBe('Error: NameError');
		expect(contents[1]).toBe('Error: NameError');
		expect(contents[2]).toContain('[Haruspex hint]');
	});

	it('hints on a repeated run_command, and another tool in between resets the streak', async () => {
		const ctx = makeCtx();
		const nudges = new NudgeState();
		await executeToolCalls(ctx, nudges, [
			call('run_command', { command: 'ls' }),
			call('run_command', { command: 'ls' }),
			call('fs_list_dir'),
			call('run_command', { command: 'ls' })
		]);
		const contents = toolMessages(ctx).map((m) => m.content);
		expect(contents[0]).toBe('ok run_command');
		expect(contents[1]).toContain('run this exact command 2 times');
		expect(contents[3]).toBe('ok run_command');
		expect(nudges.shouldStopForCommandRepeat()).toBe(false);
	});

	it('trips the repeat stop after three identical commands', async () => {
		const nudges = new NudgeState();
		await executeToolCalls(makeCtx(), nudges, [
			call('run_command', { command: 'make' }),
			call('run_command', { command: ' make ' }),
			call('run_command', { command: 'make' })
		]);
		expect(nudges.shouldStopForCommandRepeat()).toBe(true);
	});
});
