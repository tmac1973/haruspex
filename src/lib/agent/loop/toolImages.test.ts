import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { isToolImageMessage } from '#lib/agent/toolImageMessage.ts';
import { turnRunsSkill } from '#lib/skills/content.ts';
import { appendToolImages, toolImagesMessage } from './toolImages';
import { isCodeContext } from './heuristics';

const img = (n: number) => ({
	path: `deck.pptx#sheet${n}`,
	dataUrl: `data:image/jpeg;base64,${n}`
});

describe('appendToolImages', () => {
	it('adds nothing with no images', () => {
		const messages: ChatMessage[] = [{ role: 'user', content: 'look' }];
		appendToolImages(messages, []);
		expect(messages).toEqual([{ role: 'user', content: 'look' }]);
	});

	it('puts the images after the tool results, labelled, and leaves the request alone', () => {
		const request: ChatMessage = { role: 'user', content: 'make it dark' };
		const messages: ChatMessage[] = [
			request,
			{ role: 'assistant', content: '', tool_calls: [] },
			{ role: 'tool', content: 'Wrote: deck.pptx', tool_call_id: 't' }
		];
		appendToolImages(messages, [img(1), img(2)]);
		expect(messages[0]).toBe(request);
		expect(messages).toHaveLength(4);
		expect(messages[3]).toEqual({
			role: 'user',
			content: [
				{
					type: 'text',
					text: '[Images from your tool calls] In order:\n1. deck.pptx#sheet1\n2. deck.pptx#sheet2'
				},
				{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,1' } },
				{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,2' } }
			]
		});
	});
});

describe('isToolImageMessage', () => {
	it('tells tool pictures from what the user wrote', () => {
		expect(isToolImageMessage(toolImagesMessage([img(1)]))).toBe(true);
		expect(isToolImageMessage({ role: 'user', content: '[Images from your tool calls]' })).toBe(
			false
		);
		expect(
			isToolImageMessage({
				role: 'user',
				content: [
					{ type: 'text', text: 'my photo' },
					{ type: 'image_url', image_url: { url: 'data:x' } }
				]
			})
		).toBe(false);
	});
});

describe('scans for the user’s request skip tool pictures', () => {
	it('turnRunsSkill still sees a /skill run', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: '<skill_content name="deck">steps</skill_content>\n\nmake a deck' },
			{ role: 'tool', content: 'Wrote: deck.pptx', tool_call_id: 't' }
		];
		expect(turnRunsSkill(messages)).toBe(true);
		appendToolImages(messages, [img(1)]);
		expect(turnRunsSkill(messages)).toBe(true);
	});

	it('isCodeContext still reaches the Python call', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'fix it' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'c',
						type: 'function',
						function: { name: 'fs_write_text', arguments: '{"path":"main.py"}' }
					}
				]
			},
			{ role: 'tool', content: 'ok', tool_call_id: 'c' }
		];
		const before = isCodeContext(messages);
		appendToolImages(messages, [img(1)]);
		expect(isCodeContext(messages)).toBe(before);
	});
});
