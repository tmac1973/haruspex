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
