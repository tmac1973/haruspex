import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '$lib/markdown';

describe('renderMarkdown', () => {
	it('renders paragraphs', () => {
		const result = renderMarkdown('Hello world');
		expect(result).toContain('<p>Hello world</p>');
	});

	it('renders headings', () => {
		const result = renderMarkdown('# Title\n\n## Subtitle');
		expect(result).toContain('<h1>Title</h1>');
		expect(result).toContain('<h2>Subtitle</h2>');
	});

	it('renders unordered lists', () => {
		const result = renderMarkdown('- item 1\n- item 2');
		expect(result).toContain('<li>item 1</li>');
		expect(result).toContain('<li>item 2</li>');
	});

	it('renders ordered lists', () => {
		const result = renderMarkdown('1. first\n2. second');
		expect(result).toContain('<ol>');
		expect(result).toContain('<li>first</li>');
	});

	it('renders inline code', () => {
		const result = renderMarkdown('Use `console.log()` to debug');
		expect(result).toContain('<code>console.log()</code>');
	});

	it('renders code blocks with syntax highlighting', () => {
		const result = renderMarkdown('```javascript\nconst x = 1;\n```');
		expect(result).toContain('code-block');
		expect(result).toContain('Copy');
		expect(result).toContain('javascript');
	});

	it('renders code blocks without language', () => {
		const result = renderMarkdown('```\nplain text\n```');
		expect(result).toContain('code-block');
		expect(result).toContain('plain text');
	});

	it('renders bold and italic', () => {
		const result = renderMarkdown('**bold** and *italic*');
		expect(result).toContain('<strong>bold</strong>');
		expect(result).toContain('<em>italic</em>');
	});

	it('renders links', () => {
		const result = renderMarkdown('[click](https://example.com)');
		expect(result).toContain('<a href="https://example.com"');
		expect(result).toContain('click</a>');
	});

	it('escapes HTML in code blocks', () => {
		const result = renderMarkdown('```\n<script>alert("xss")</script>\n```');
		expect(result).not.toContain('<script>');
		expect(result).toContain('&lt;script&gt;');
	});

	it('converts thinking blocks to collapsed details', () => {
		const result = renderMarkdown(
			'<think>Let me reason about this...</think>\n\nThe answer is 42.'
		);
		expect(result).toContain('thinking-block');
		expect(result).toContain('<summary>');
		expect(result).toContain('Thinking...');
		expect(result).toContain('reason about this');
		expect(result).toContain('The answer is 42');
	});

	it('removes empty thinking blocks', () => {
		const result = renderMarkdown('<think></think>\n\nJust the answer.');
		expect(result).not.toContain('thinking-block');
		expect(result).toContain('Just the answer');
	});
});
