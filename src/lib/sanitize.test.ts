import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize';
import { renderMarkdown } from './markdown';

describe('sanitizeHtml', () => {
	it('strips <script> tags', () => {
		const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
		expect(out).toContain('<p>hi</p>');
		expect(out).not.toContain('script');
	});

	it('strips inline event handlers (script-less XSS)', () => {
		expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
		expect(sanitizeHtml('<svg onload="alert(1)"></svg>')).not.toContain('onload');
		expect(sanitizeHtml('<div onclick="alert(1)">x</div>')).not.toContain('onclick');
	});

	it('strips javascript: URIs but keeps http(s) links', () => {
		expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
		expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain('https://example.com');
	});

	it('forbids form controls (phishing surface) but keeps button', () => {
		const out = sanitizeHtml(
			'<form action="https://evil"><input name="pw"></form><button>ok</button>'
		);
		expect(out).not.toContain('<form');
		expect(out).not.toContain('<input');
		expect(out).toContain('<button>ok</button>');
	});

	it('keeps pandas-style tables intact', () => {
		const table =
			'<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
		expect(sanitizeHtml(table)).toBe(table);
	});

	it('keeps data: images (sandbox plot artifacts)', () => {
		const img = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="plot">';
		expect(sanitizeHtml(img)).toContain('data:image/png;base64');
	});
});

describe('renderMarkdown sanitization', () => {
	it('neutralizes raw HTML injection in model output', () => {
		const out = renderMarkdown('hello <img src=x onerror="alert(1)"> world');
		expect(out).not.toContain('onerror');
	});

	it('neutralizes javascript: markdown links', () => {
		const out = renderMarkdown('[click](javascript:alert(1))');
		expect(out).not.toContain('javascript:');
	});

	it('strips <script> emitted as raw HTML blocks', () => {
		const out = renderMarkdown('before\n\n<script>fetch("http://evil")</script>\n\nafter');
		expect(out).not.toContain('<script');
		expect(out).toContain('before');
		expect(out).toContain('after');
	});

	it('keeps code-block chrome: header buttons carry data-action, no inline handlers', () => {
		const out = renderMarkdown('```bash\nls -la\n```');
		expect(out).toContain('data-action="copy"');
		expect(out).toContain('data-action="shell-paste"');
		expect(out).toContain('data-action="shell-run"');
		expect(out).not.toContain('onclick');
	});

	it('keeps thinking blocks (<details>/<summary>)', () => {
		const out = renderMarkdown('<think>pondering</think>answer');
		expect(out).toContain('<details class="thinking-block">');
		expect(out).toContain('answer');
	});

	it('keeps syntax-highlight markup', () => {
		const out = renderMarkdown('```python\nprint("hi")\n```');
		expect(out).toContain('hljs');
		expect(out).toContain('language-python');
	});
});
