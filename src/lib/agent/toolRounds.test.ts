import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { droppingUnit, sanitizeOrphanToolResults } from './toolRounds';

const calls = (...ids: string[]): ChatMessage => ({
	role: 'assistant',
	content: '',
	tool_calls: ids.map((id) => ({
		id,
		type: 'function' as const,
		function: { name: 'fs_read_text', arguments: '{}' }
	}))
});
const result = (id: string): ChatMessage => ({ role: 'tool', content: id, tool_call_id: id });

describe('droppingUnit', () => {
	const msgs: ChatMessage[] = [
		{ role: 'user', content: 'go' },
		calls('a', 'b'),
		result('a'),
		result('b'),
		calls('c'),
		result('c')
	];

	it('takes a round from its calls message or from any of its results', () => {
		expect(droppingUnit(msgs, 1)).toEqual([1, 2, 3]);
		expect(droppingUnit(msgs, 3)).toEqual([1, 2, 3]);
		expect(droppingUnit(msgs, 5)).toEqual([4, 5]);
	});

	it('leaves anything else, or a result with no call, on its own', () => {
		expect(droppingUnit(msgs, 0)).toEqual([0]);
		expect(droppingUnit([result('x')], 0)).toEqual([0]);
	});
});

describe('sanitizeOrphanToolResults', () => {
	it('removes results whose call is gone and keeps the rest', () => {
		const msgs = [result('gone'), calls('a'), result('a')];
		sanitizeOrphanToolResults(msgs);
		expect(msgs.map((m) => m.tool_call_id ?? 'calls')).toEqual(['calls', 'a']);
	});
});
