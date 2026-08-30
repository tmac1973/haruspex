import { describe, it, expect } from 'vitest';
import { looksLikeImageOnlyRequest } from '$lib/agent/loop/iteration';

describe('looksLikeImageOnlyRequest', () => {
	// Must match: nudging these into research would be wrong.
	it.each([
		'show me a picture of a red panda',
		'Show me some photos of Kyoto',
		'find me a pic of the Eiffel Tower',
		'give me images of spider monkeys',
		'what does a mandrill look like?',
		'pictures of baboons',
		'images of the ThinkPad X1',
		'send me a photo of a capybara'
	])('treats %s as image-only', (q) => {
		expect(looksLikeImageOnlyRequest(q)).toBe(true);
	});

	// Must NOT match: these deserve real research, and a false positive here
	// silently disables the nudge for exactly the case it exists for.
	it.each([
		'Tell me about monkeys?',
		'What is a red panda?',
		'Compare the ThinkPad X1 and the MacBook Air',
		'How do spider monkeys use their tails?',
		'Explain recursion',
		'What is the best budget GPU in 2026?',
		'Write me a report on Kyoto tourism',
		'Tell me about the history of photography'
	])('treats %s as needing research', (q) => {
		expect(looksLikeImageOnlyRequest(q)).toBe(false);
	});
});

import { wroteRemoteImageMarkdown } from '$lib/agent/loop/iteration';

describe('wroteRemoteImageMarkdown', () => {
	it('detects an invented remote image link', () => {
		expect(
			wroteRemoteImageMarkdown(
				'![Rhesus macaque](https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/x/440px-y.jpg)'
			)
		).toBe(true);
	});

	// The Python sandbox writes these for inline plots, and models routinely
	// reference a figure they just saved. Neither claims to have found a
	// picture on the web, so neither should trigger the nudge.
	it.each([
		['data URL from the sandbox', '![plot](data:image/png;base64,iVBORw0KGgo=)'],
		['relative path after savefig', '![plot](sine_wave.png)'],
		['absolute local path', '![chart](/home/tim/out.png)'],
		['no images at all', 'Just prose with a [link](https://example.com).'],
		['empty', '']
	])('ignores %s', (_label, content) => {
		expect(wroteRemoteImageMarkdown(content)).toBe(false);
	});

	it('handles null and undefined content', () => {
		expect(wroteRemoteImageMarkdown(null)).toBe(false);
		expect(wroteRemoteImageMarkdown(undefined)).toBe(false);
	});
});
