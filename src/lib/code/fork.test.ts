import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import { renderSlashMessage } from '#lib/skills/content.ts';
import { forkPoint } from './fork';

const thread: ChatMessage[] = [
	{ role: 'user', content: 'find x' },
	{
		role: 'assistant',
		content: '',
		tool_calls: [{ id: 'c1', type: 'function', function: { name: 'code_grep', arguments: '{}' } }]
	},
	{ role: 'tool', tool_call_id: 'c1', content: 'a.ts:1' },
	{ role: 'assistant', content: 'In a.ts.' },
	{
		role: 'user',
		content: [
			{ type: 'text', text: 'and this one?' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
		]
	},
	{ role: 'assistant', content: 'That too.' }
];

describe('forkPoint', () => {
	it('keeps an answer and everything before it', () => {
		expect(forkPoint(thread, 3)).toEqual({ at: 4, prefill: null });
		expect(forkPoint(thread, 5)).toEqual({ at: 6, prefill: null });
	});

	it('keeps what came before a user message and gives the message back', () => {
		expect(forkPoint(thread, 0)).toEqual({ at: 0, prefill: { text: 'find x', images: [] } });
		expect(forkPoint(thread, 4)).toEqual({
			at: 4,
			prefill: { text: 'and this one?', images: ['data:image/png;base64,AAA'] }
		});
	});

	it('gives back what was typed for a skill run, not the expanded skill', () => {
		const doc = { name: 'review', body: 'Review the diff.', files: [] } as unknown as SkillDoc;
		const skill: ChatMessage = { role: 'user', content: renderSlashMessage(doc, 'the parser') };
		expect(forkPoint([skill], 0)?.prefill?.text).toBe('the parser');
	});

	it('refuses tool calls, tool results and indices out of range', () => {
		expect(forkPoint(thread, 1)).toBeNull();
		expect(forkPoint(thread, 2)).toBeNull();
		expect(forkPoint(thread, 6)).toBeNull();
		expect(forkPoint(thread, -1)).toBeNull();
	});
});
