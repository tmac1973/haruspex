import { describe, expect, it } from 'vitest';
import { mailBody, plainText, sanitizeMailHtml } from './body';

describe('mail body', () => {
	it('keeps cid pictures only when asked, and never a picture from the web', () => {
		const md = '![Map](cid:p1) ![Web](https://t.example/x.png)';
		const off = mailBody(md).html;
		expect(off).not.toContain('<img');
		const on = mailBody(md, { cidPictures: true }).html;
		expect(on).toContain('<img src="cid:p1" alt="Map"');
		expect(on).not.toContain('t.example');
	});

	it('does not let cid: stand in for a link', () => {
		const html = sanitizeMailHtml('<a href="cid:p1">x</a>', true);
		expect(html).toBe('<a>x</a>');
	});

	it('names pictures in the plain text', () => {
		expect(plainText('See ![Map](cid:p1) and ![](cid:p2).', true)).toBe(
			'See [Picture: Map] and [Picture].'
		);
	});

	it('styles tables inline, since mail clients drop style sheets', () => {
		const { html } = mailBody('| a |\n|---|\n| 1 |');
		expect(html).toContain('<table style="border-collapse:collapse');
		expect(html).toContain('<td style="border:1px solid #ccc');
	});

	it('adds a footer to both parts only when given one', () => {
		expect(mailBody('Hi').text).toBe('Hi');
		const both = mailBody('Hi', { footer: 'Sent by <me>' });
		expect(both.text).toBe('Hi\n\n—\nSent by <me>');
		expect(both.html).toContain('Sent by &#60;me&#62;');
	});
});
