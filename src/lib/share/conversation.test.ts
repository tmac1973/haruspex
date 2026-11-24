import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import { answerText, conversationHtml, conversationText, conversationTurns } from './conversation';

const messages: ChatMessage[] = [
	{ role: 'system', content: 'You are Haruspex.' },
	{ role: 'user', content: 'Plan a <trip>' },
	{ role: 'assistant', content: '<think>Where?</think>Go to **Oslo**.' },
	{ role: 'assistant', content: '' },
	{ role: 'user', content: 'Background task "Render" finished: done' },
	{
		role: 'user',
		content: [
			{ type: 'text', text: 'And this?' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
		]
	},
	{ role: 'assistant', content: '<think>Only reasoning.</think>' }
];

describe('sharing a conversation', () => {
	it('keeps what was typed and the answers, not reasoning or notices', () => {
		expect(conversationTurns(messages)).toEqual([
			{ role: 'user', text: 'Plan a <trip>', images: [] },
			{ role: 'assistant', text: 'Go to **Oslo**.', images: [] },
			{ role: 'user', text: 'And this?', images: ['data:image/png;base64,AAAA'] },
			{ role: 'assistant', text: 'Only reasoning.', images: [] }
		]);
	});

	it('takes the reasoning as the answer only when there is nothing else', () => {
		expect(answerText('<think>a</think>b')).toBe('b');
		expect(answerText('<think>a</think>')).toBe('a');
	});

	it('writes plain text under who said it', () => {
		const text = conversationText(messages);
		expect(text.startsWith('You:\nPlan a <trip>\n\nHaruspex:\nGo to **Oslo**.')).toBe(true);
		expect(text).toContain('You:\nAnd this?\n[1 picture attached]');
	});

	it('renders HTML with the typed text escaped and the answers as Markdown', () => {
		const html = conversationHtml('Trip & more', messages);
		expect(html).toContain('<h1>Trip &#38; more</h1>');
		expect(html).toContain('Plan a &#60;trip&#62;');
		expect(html).toContain('<strong>Oslo</strong>');
		expect(html).toContain('<img src="data:image/png;base64,AAAA"');
		expect(html).not.toContain('Where?');
	});
});
