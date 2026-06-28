import { describe, it, expect } from 'vitest';
import { appendStreamDelta, hasStreamingAnswer } from './think-stream';

describe('appendStreamDelta', () => {
	it('opens a think block for reasoning and closes it when content starts', () => {
		let buf = '';
		buf = appendStreamDelta(buf, { reasoning_content: 'hmm' });
		expect(buf).toBe('<think>hmm');
		buf = appendStreamDelta(buf, { reasoning_content: ' more' });
		expect(buf).toBe('<think>hmm more');
		buf = appendStreamDelta(buf, { content: 'answer' });
		expect(buf).toBe('<think>hmm more</think>\n\nanswer');
	});
});

describe('hasStreamingAnswer', () => {
	it('is false while only reasoning has streamed (unclosed think block)', () => {
		expect(hasStreamingAnswer('')).toBe(false);
		expect(hasStreamingAnswer('<think>thinking hard')).toBe(false);
		expect(hasStreamingAnswer('<think>thinking hard\nwith newlines')).toBe(false);
	});

	it('is false for a closed think block with no answer yet', () => {
		expect(hasStreamingAnswer('<think>done thinking</think>\n\n')).toBe(false);
	});

	it('is true once visible answer text has streamed', () => {
		expect(hasStreamingAnswer('<think>reasoned</think>\n\nThe answer')).toBe(true);
		expect(hasStreamingAnswer('plain answer with no reasoning')).toBe(true);
	});
});
