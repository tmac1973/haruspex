import { describe, expect, it } from 'vitest';
import { failureNote, NO_SOURCES, replyParts } from './reply';

const answer = [
	'## Answer',
	'',
	'The best one is [Brand X](https://x.example/bike) [1].',
	'',
	'## Sources',
	'',
	'[1] Brand X review — https://review.example/x'
].join('\n');

describe('reply parts', () => {
	it('links Sources URLs in HTML and writes them out in plain text', () => {
		const { text, html } = replyParts(answer);
		expect(html).toContain('<a href="https://review.example/x">');
		expect(html).toContain('<a href="https://x.example/bike">Brand X</a>');
		expect(text).toContain('Brand X (https://x.example/bike)');
		expect(text).toContain('https://review.example/x');
		expect(text).not.toContain(NO_SOURCES);
	});

	it('strips scripts, images and handlers, and javascript: links lose their href', () => {
		const { html } = replyParts(
			'Hi <script>alert(1)</script><img src="https://t.example/p.gif" onerror="x()">' +
				' <a href="javascript:alert(1)" onclick="y()">bad</a> [cid](cid:foo) ' +
				'![pic](https://t.example/q.png)\n\n## Sources\n\nnone'
		);
		expect(html).not.toMatch(/<script|<img|onerror|onclick|javascript:|cid:|t\.example/);
		expect(html).toContain('>bad</a>');
		expect(html).not.toMatch(/<a href[^>]*>bad/);
	});

	it('says so when the answer lists no sources, but not on a failure note', () => {
		const { text, html } = replyParts('Just an answer.');
		expect(text).toContain(NO_SOURCES);
		expect(html).toContain(NO_SOURCES);
		const note = replyParts(failureNote('the model was not reachable'), true);
		expect(note.text).not.toContain(NO_SOURCES);
		expect(note.text).toContain("Haruspex couldn't answer this: the model was not reachable.");
	});
});
