import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseCutOffError, type ChatCompletionResponse, type ChatMessage } from '#lib/api.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import { renderSkillContent } from '#lib/skills/content.ts';
import { LoopState, type LoopContext } from './context';
import { NudgeState } from './nudges';
import { diversityNudgePrompt, phantomImageNudgePrompt, researchNudgePrompt } from './heuristics';
import { steeringNote } from './steeringQueue';

const synth = vi.hoisted(() => ({ lastFinish: 'stop' as string | null }));
const forced = vi.hoisted(() => ({ calls: 0 }));

vi.mock('#lib/debugLog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/debugLog.ts')>()),
	logDebug: vi.fn()
}));
vi.mock('#lib/agent/loop/modelCall.ts', () => ({
	streamFinalSynthesis: async () => ({
		lastFinish: synth.lastFinish,
		totalChunks: 1,
		totalContent: 5
	})
}));
vi.mock('#lib/agent/loop/forcedFinal.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/agent/loop/forcedFinal.ts')>()),
	forceFinalToolCall: async () => {
		forced.calls++;
	}
}));

import { finalizeNoToolCalls } from './finalAnswer';

function harness(over: Partial<LoopContext> = {}, steering: { text: string }[] = []) {
	const out = {
		chunks: [] as unknown[],
		completed: 0,
		errors: [] as Error[],
		added: [] as ChatMessage[]
	};
	const ctx = {
		messages: [{ role: 'user', content: 'Tell me about monkeys' }],
		tools: [],
		forceFinalTool: null,
		maxResponseTokens: 1000,
		expectsFileOutput: false,
		options: {
			onStreamChunk: (c: unknown) => out.chunks.push(c),
			onComplete: () => out.completed++,
			onError: (e: Error) => out.errors.push(e),
			onMessageAdded: (m: ChatMessage) => out.added.push(m),
			takeSteering: () => steering.splice(0)
		},
		...over
	} as unknown as LoopContext;
	return { ctx, out };
}

function reply(content: string | null, finish = 'stop'): ChatCompletionResponse {
	return { content, finish_reason: finish } as ChatCompletionResponse;
}

async function finalize(
	ctx: LoopContext,
	response: ChatCompletionResponse,
	nudges = new NudgeState(),
	state = new LoopState()
) {
	return finalizeNoToolCalls(ctx, state, nudges, response, {} as never, {}, 1);
}

/** The text of the last message the loop appended. */
function lastAdded(added: ChatMessage[]): string {
	return String(added.at(-1)?.content ?? '');
}

beforeEach(() => {
	synth.lastFinish = 'stop';
	forced.calls = 0;
});

describe('finalizeNoToolCalls', () => {
	it('commits a clean non-stream answer without re-streaming', async () => {
		const { ctx, out } = harness();
		expect(await finalize(ctx, reply('Monkeys are primates.'))).toBe('complete');
		expect(out.chunks).toEqual([
			{ delta: { content: 'Monkeys are primates.' }, finish_reason: 'stop' }
		]);
		expect(out.completed).toBe(1);
		expect(out.errors).toEqual([]);
	});

	it('re-streams when the non-stream answer was cut off, and reports a cut-off re-stream', async () => {
		synth.lastFinish = 'length';
		const { ctx, out } = harness();
		const state = new LoopState();
		state.usedTools = true;
		expect(await finalize(ctx, reply('Monkeys are', 'length'), new NudgeState(), state)).toBe(
			'complete'
		);
		expect(out.chunks).toEqual([]);
		expect(out.completed).toBe(1);
		expect(out.errors).toHaveLength(1);
		expect(out.errors[0]).toBeInstanceOf(ResponseCutOffError);
	});

	it('re-streams an answer that was only reasoning, with no error when it finishes', async () => {
		const { ctx, out } = harness();
		await finalize(ctx, reply('<think>hmm</think>'));
		expect(out.chunks).toEqual([]);
		expect(out.completed).toBe(1);
		expect(out.errors).toEqual([]);
	});

	it('sends the model back for real pictures when it invented image URLs', async () => {
		const { ctx, out } = harness();
		const nudges = new NudgeState();
		const outcome = await finalize(
			ctx,
			reply('![macaque](https://upload.wikimedia.org/x.jpg)'),
			nudges
		);
		expect(outcome).toBe('continue');
		expect(lastAdded(out.added)).toContain(phantomImageNudgePrompt());
		expect(out.completed).toBe(0);
		// Once only: the second time the answer stands.
		expect(await finalize(ctx, reply('![m](https://upload.wikimedia.org/x.jpg)'), nudges)).toBe(
			'complete'
		);
	});

	it('nudges a turn that only searched for a picture to research', async () => {
		const { ctx, out } = harness();
		const nudges = new NudgeState();
		nudges.markImageSearchUsed();
		const state = new LoopState();
		state.usedTools = true;
		expect(await finalize(ctx, reply('Monkeys are primates.'), nudges, state)).toBe('continue');
		expect(lastAdded(out.added)).toContain(researchNudgePrompt());
	});

	it('nudges for more sources after one search and one page', async () => {
		const { ctx, out } = harness();
		const nudges = new NudgeState();
		nudges.markWebSearchUsed();
		nudges.recordFetchedUrl('https://a.example');
		const state = new LoopState();
		state.usedTools = true;
		expect(await finalize(ctx, reply('Monkeys are primates.'), nudges, state)).toBe('continue');
		expect(lastAdded(out.added)).toContain(diversityNudgePrompt(1));
	});

	it('skips the research gates on a turn that runs a skill', async () => {
		const skill = renderSkillContent({
			name: 'weather',
			body: 'Run the script.',
			files: []
		} as unknown as SkillDoc);
		const { ctx, out } = harness({ messages: [{ role: 'user', content: skill }] });
		const nudges = new NudgeState();
		nudges.markWebSearchUsed();
		const state = new LoopState();
		state.usedTools = true;
		expect(await finalize(ctx, reply('Sunny.'), nudges, state)).toBe('complete');
		expect(out.completed).toBe(1);
	});

	it('keeps the turn going for queued steering instead of finishing', async () => {
		const { ctx, out } = harness({}, [{ text: 'Shorter please' }]);
		const state = new LoopState();
		expect(await finalize(ctx, reply('Monkeys are primates.'), new NudgeState(), state)).toBe(
			'continue'
		);
		expect(state.steeringContinue).toBe(true);
		expect(out.completed).toBe(0);
		expect(out.added.map((m) => m.content)).toEqual([
			'Monkeys are primates.',
			'Shorter please',
			steeringNote(1)
		]);
	});

	it('forces the final tool instead of committing prose', async () => {
		const { ctx, out } = harness({ forceFinalTool: 'submit_findings' });
		expect(await finalize(ctx, reply('Here are my findings.'))).toBe('complete');
		expect(forced.calls).toBe(1);
		expect(out.chunks).toEqual([]);
	});
});
