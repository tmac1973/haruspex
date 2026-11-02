import { describe, expect, it } from 'vitest';
import { SHIM, injectShim } from './shim';

const TAG = `<script>${SHIM}</script>`;

describe('SHIM', () => {
	it('is one line', () => {
		expect(SHIM).not.toMatch(/[\r\n]/);
	});

	it('still parses once joined', () => {
		expect(() => new Function(SHIM)).not.toThrow();
	});
});

describe('injectShim', () => {
	it('goes straight after the head tag', () => {
		const html = '<!DOCTYPE html>\n<html lang="en">\n<head data-x="1">\n<title>t</title>';
		expect(injectShim(html)).toBe(
			`<!DOCTYPE html>\n<html lang="en">\n<head data-x="1">${TAG}\n<title>t</title>`
		);
	});

	it('does not mistake a header for the head', () => {
		const html = '<html><body><header>x</header></body></html>';
		expect(injectShim(html)).toBe(`<html>${TAG}<body><header>x</header></body></html>`);
	});

	it('goes after the html tag when there is no head', () => {
		expect(injectShim('<HTML>\n<body></body>')).toBe(`<HTML>${TAG}\n<body></body>`);
	});

	it('goes at the start when there is neither', () => {
		expect(injectShim('<canvas></canvas>')).toBe(`${TAG}<canvas></canvas>`);
	});

	it('keeps every original line on its line number', () => {
		for (const html of [
			'<!doctype html>\n<html>\n<head>\n<script type="module">\nboom();\n</script>\n</head>',
			'<html>\n<body>\n<script>\nboom();\n</script>',
			'\n\n<script>\nboom();\n</script>'
		]) {
			const before = html.split('\n');
			const after = injectShim(html).split('\n');
			expect(after).toHaveLength(before.length);
			const line = before.findIndex((l) => l === 'boom();');
			expect(after[line]).toBe('boom();');
		}
	});
});
