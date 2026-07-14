import { describe, it, expect } from 'vitest';
import { appendStreamDelta, createThinkStreamState, hasStreamingAnswer } from './think-stream';
import type { StreamChunk } from '$lib/api';

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

	// The memoized (stateful) path must be byte-identical to the
	// buffer-scanning fallback for every stream shape.
	const streams: Record<string, StreamChunk['delta'][]> = {
		'reasoning split across deltas, then content split across deltas': [
			{ reasoning_content: 'let me ' },
			{ reasoning_content: 'think' },
			{ content: 'The answer' },
			{ content: ' is 42.' }
		],
		'content only, no reasoning': [{ content: 'Plain ' }, { content: 'answer.' }],
		'reasoning only, never closed': [{ reasoning: 'still ' }, { reasoning: 'thinking' }],
		'reasoning via the OpenRouter alias field': [{ reasoning: 'alias path' }, { content: 'done' }],
		'interleaved trailing reasoning after content': [
			{ reasoning_content: 'plan' },
			{ content: 'part one' },
			{ reasoning_content: ' post-hoc' },
			{ content: ' part two' }
		]
	};

	for (const [name, deltas] of Object.entries(streams)) {
		it(`stateful path matches stateless: ${name}`, () => {
			let plain = '';
			let memo = '';
			const state = createThinkStreamState();
			for (const delta of deltas) {
				plain = appendStreamDelta(plain, delta);
				memo = appendStreamDelta(memo, delta, state);
			}
			expect(memo).toBe(plain);
		});
	}
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
