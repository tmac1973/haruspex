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
