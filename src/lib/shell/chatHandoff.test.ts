import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '$lib/api';
import {
	prepareChatHandoff,
	shellNameForConversation,
	buildHandoffNote,
	HANDOFF_KEEP_PROSE
} from './chatHandoff';

const user = (text: string): ChatMessage => ({ role: 'user', content: text });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', content: text });

describe('prepareChatHandoff', () => {
	it('carries the prose and leads with the handoff note', () => {
		const out = prepareChatHandoff([user('why is nginx down?'), assistant('check the unit')]);
		expect(out).toHaveLength(3);
		expect(out[0].role).toBe('system');
		expect(out[1]).toEqual(user('why is nginx down?'));
		expect(out[2]).toEqual(assistant('check the unit'));
	});

	it('drops tool calls, tool results, and the chat tab system prompt', () => {
		const toolCall: ChatMessage = {
			role: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'c1', type: 'function', function: { name: 'run_python', arguments: '{}' } }
			]
		};
		const toolResult: ChatMessage = { role: 'tool', content: '42', tool_call_id: 'c1' };
		const out = prepareChatHandoff([
			{ role: 'system', content: 'chat tab prompt' },
			user('compute it'),
			toolCall,
			toolResult,
			assistant('the answer is 42')
		]);
		expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
		// The one system message present is ours, not the chat tab's.
		expect(out[0].content).not.toBe('chat tab prompt');
		expect(out.some((m) => m.tool_calls)).toBe(false);
	});

	it('keeps only the most recent prose turns and says so in the note', () => {
		const long: ChatMessage[] = [];
		for (let i = 0; i < 40; i++) long.push(i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`));
		const out = prepareChatHandoff(long);
		expect(out).toHaveLength(HANDOFF_KEEP_PROSE + 1);
		// Last message in, last message out — the recent window, not the oldest.
		expect(out[out.length - 1]).toEqual(long[long.length - 1]);
		expect(out[0].content).toContain('Older messages');
	});

	it('omits the trim wording when the whole thread fits', () => {
		const out = prepareChatHandoff([user('hi'), assistant('hello')]);
		expect(out[0].content).not.toContain('Older messages');
	});

	it('preserves multimodal user content', () => {
		const withImage: ChatMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'what is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
			]
		};
		expect(prepareChatHandoff([withImage])[1]).toEqual(withImage);
	});

	it('returns nothing to carry for a conversation with no prose', () => {
		expect(prepareChatHandoff([])).toEqual([]);
		expect(prepareChatHandoff([{ role: 'system', content: 'prompt' }])).toEqual([]);
	});
});

describe('buildHandoffNote', () => {
	it('tells the model the terminal is fresh, so imported talk is not work done here', () => {
		const note = String(buildHandoffNote(false).content);
		expect(note).toContain('brand-new session');
		expect(note).toContain('nothing discussed above has been run');
	});
});

describe('shellNameForConversation', () => {
	it('truncates a long title so the tab strip stays readable', () => {
		const name = shellNameForConversation('debugging the nginx reverse proxy config');
		expect(name).not.toBeNull();
		expect(name!.length).toBeLessThanOrEqual(18);
		expect(name!.endsWith('…')).toBe(true);
	});

	it('passes a short title through', () => {
		expect(shellNameForConversation('nginx down')).toBe('nginx down');
	});

	it('falls back to the registry default for a blank title', () => {
		expect(shellNameForConversation('   ')).toBeNull();
		expect(shellNameForConversation(undefined)).toBeNull();
	});
});
