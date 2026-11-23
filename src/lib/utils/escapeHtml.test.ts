import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
	it('escapes what could end a text node or a quoted attribute', () => {
		expect(escapeHtml('<a href="x">Tom & Jerry</a>')).toBe(
			'&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;'
		);
	});

	it('escapes an ampersand once, before the others', () => {
		expect(escapeHtml('&lt;')).toBe('&amp;lt;');
	});
});
