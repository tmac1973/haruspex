import { describe, it, expect } from 'vitest';
import './user-question';
import { executeTool } from './registry';
import type { ToolContext } from './types';

const baseCtx: ToolContext = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	filesWrittenThisTurn: new Set(),
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	interactive: false
};

describe('ask_user_question tool', () => {
	it('fails safe when no interactive user is present', async () => {
		const out = await executeTool(
			'ask_user_question',
			{ question: 'Pick one', options: [{ label: 'A' }] },
			{ ...baseCtx, interactive: false }
		);
		expect(out.result).toContain('No interactive user');
	});

	it('rejects an empty question before reaching the modal', async () => {
		const out = await executeTool(
			'ask_user_question',
			{ question: '   ', options: [{ label: 'A' }] },
			{ ...baseCtx, interactive: true }
		);
		expect(out.result).toContain('non-empty');
	});
});

/**
 * A question with nothing to pick is indistinguishable, on screen, from a
 * deliberately open one. A real guided-planning run spent an entire interview
 * that way: the model emitted `options` as a malformed JSON string, every call
 * silently lost it, and the user was asked to type free text each time with no
 * sign anything had gone wrong.
 */
describe('ask_user_question — options that yield nothing', () => {
	const ask = (options: unknown) =>
		executeTool(
			'ask_user_question',
			{ question: 'How should the turn scheduler work?', options },
			{ ...baseCtx, interactive: true }
		);

	it('reports a string that coercion could not rescue', async () => {
		// A JSON-ish string IS rescued now (see coerce.test.ts) and reaches the
		// modal; this is the case nothing can recover.
		const out = await ask('either A, B, or C');
		expect(out.result).toContain('options');
		expect(out.result).toContain('string');
		expect(out.result).toContain('not a string containing JSON');
	});

	it('reports an empty list', async () => {
		const out = await ask([]);
		expect(out.result).toContain('no usable labels');
	});

	it('reports a list whose entries have no usable label', async () => {
		const out = await ask([{ description: 'no label here' }, { label: '   ' }]);
		expect(out.result).toContain('no usable labels');
	});

	it('reports options being absent entirely', async () => {
		const out = await executeTool(
			'ask_user_question',
			{ question: 'Anything?' },
			{ ...baseCtx, interactive: true }
		);
		expect(out.result).toContain('nothing');
	});

	it('still tells the model the user can always type an answer', async () => {
		// Otherwise the repair is to drop options, which is the failure again.
		const out = await ask([]);
		expect(out.result).toContain('type their own answer');
	});
});

describe('ask_user_question body', () => {
	it('passes a body to the modal under the question, and none when blank', async () => {
		const asked: Array<{ question: string; body?: string }> = [];
		const askUser = async (req: { question: string; body?: string }) => {
			asked.push(req);
			return { kind: 'selected' as const, labels: ['A'] };
		};
		const ctx = { ...baseCtx, interactive: true, askUser } as ToolContext;
		await executeTool(
			'ask_user_question',
			{ question: 'Pick one', body: '  **Context** here  ', options: [{ label: 'A' }] },
			ctx
		);
		await executeTool(
			'ask_user_question',
			{ question: 'Pick one', body: '   ', options: [{ label: 'A' }] },
			ctx
		);
		expect(asked[0].body).toBe('**Context** here');
		expect('body' in asked[1]).toBe(false);
	});
});

describe('ask_user_question multi-select', () => {
	function ctxAnswering(answer: import('./types').UserAnswer, asked: unknown[] = []) {
		const askUser = async (req: unknown) => {
			asked.push(req);
			return answer;
		};
		return { ...baseCtx, interactive: true, askUser } as ToolContext;
	}
	const options = [{ label: 'Saves' }, { label: 'Leaderboard, global' }, { label: 'Sound' }];

	it('tells the model which tool flag gives checkboxes', async () => {
		const { getToolSchemas } = await import('./registry');
		const schema = getToolSchemas({
			hasWorkingDir: false,
			toolAllowlist: ['ask_user_question']
		}).find((s) => s.function.name === 'ask_user_question')!;
		expect(schema.function.description).toContain('allow_multiple');
		expect(schema.function.description).toContain('which of these');
	});

	it('asks with checkboxes when the model sets allow_multiple, even as a string', async () => {
		const asked: Array<{ allowMultiple?: boolean }> = [];
		const ctx = ctxAnswering({ kind: 'selected', labels: ['Saves'] }, asked);
		await executeTool(
			'ask_user_question',
			{ question: 'Which features?', options, allow_multiple: 'true' },
			ctx
		);
		expect(asked[0].allowMultiple).toBe(true);
	});

	it('lists several picks one per line, so a comma in a label cannot split it', async () => {
		const ctx = ctxAnswering({ kind: 'selected', labels: ['Saves', 'Leaderboard, global'] });
		const out = await executeTool(
			'ask_user_question',
			{ question: 'Which features?', options, allow_multiple: true },
			ctx
		);
		expect(out.result).toContain('selected 2 of the options');
		expect(out.result).toContain('- Saves\n- Leaderboard, global');
	});

	it('passes on what the user typed alongside their ticks', async () => {
		const ctx = ctxAnswering({ kind: 'selected', labels: ['Sound'], note: 'and a pause menu' });
		const out = await executeTool(
			'ask_user_question',
			{ question: 'Which features?', options, allow_multiple: true },
			ctx
		);
		expect(out.result).toContain('- Sound');
		expect(out.result).toContain('They also wrote: and a pause menu');
	});

	it('keeps the single-choice answer as it was', async () => {
		const ctx = ctxAnswering({ kind: 'selected', labels: ['Sound'] });
		const out = await executeTool('ask_user_question', { question: 'One?', options }, ctx);
		expect(out.result).toBe('The user selected: Sound');
	});
});
