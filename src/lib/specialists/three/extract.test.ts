import { describe, expect, it } from 'vitest';
import { extractHtml } from './extract';

const DOC = '<!DOCTYPE html>\n<html><body><canvas></canvas></body></html>';

describe('extractHtml', () => {
	it('takes a fenced html block', () => {
		expect(extractHtml(`Here it is:\n\`\`\`html\n${DOC}\n\`\`\`\nEnjoy.`)).toBe(`${DOC}\n`);
	});

	it('takes the longest of several blocks', () => {
		const short = '```html\n<p>hi</p>\n```';
		const long = `\`\`\`html\n${DOC}\n\`\`\``;
		expect(extractHtml(`${short}\n${long}\n${short}`)).toBe(`${DOC}\n`);
	});

	it('takes a bare document', () => {
		expect(extractHtml(`\n  ${DOC}  \n`)).toBe(DOC);
		expect(extractHtml('<html lang="en"></html>')).toBe('<html lang="en"></html>');
	});

	it('ignores a think block before the document', () => {
		expect(extractHtml(`<think>Maybe \`\`\`html\n<p>no</p>\n\`\`\`</think>\n${DOC}`)).toBe(DOC);
	});

	it('returns null when there is no HTML', () => {
		expect(extractHtml('Sorry, I cannot do that.')).toBeNull();
		expect(extractHtml('```js\nconsole.warn(1)\n```')).toBeNull();
	});
});
