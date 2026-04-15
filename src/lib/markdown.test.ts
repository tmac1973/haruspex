import { describe, it, expect } from 'vitest';
import {
	processCitations,
	renderMarkdown,
	stripMarkdownForTTS,
	stripToolCallArtifacts
} from '$lib/markdown';

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

	it('repairs table separator with missing pipe (crammed cells)', () => {
		// Real failure mode from Qwen 9B: 5-column header but separator row has
		// `| :--- | :--- | :--- | :--- :--- |` — two alignment tokens crammed
		// into one cell with a missing pipe. Marked rejects it as a table.
		const md =
			'| Feature | MSP | MSSP | MDR | XDR |\n' +
			'| :--- | :--- | :--- | :--- :--- |\n' +
			'| Cost | Low | Medium | High | Varies |';
		const result = renderMarkdown(md);
		expect(result).toContain('<table>');
		expect(result).toMatch(/<th[^>]*>Feature<\/th>/);
		expect(result).toMatch(/<th[^>]*>XDR<\/th>/);
		expect(result).toMatch(/<td[^>]*>Varies<\/td>/);
	});

	it('repairs table separator with too few cells', () => {
		// Separator row entirely short (3 cells for a 4-column header)
		const md = '| A | B | C | D |\n| --- | --- | --- |\n| 1 | 2 | 3 | 4 |';
		const result = renderMarkdown(md);
		expect(result).toContain('<table>');
		expect(result).toMatch(/<th[^>]*>D<\/th>/);
		expect(result).toMatch(/<td[^>]*>4<\/td>/);
	});

	it('leaves well-formed tables alone', () => {
		const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
		const result = renderMarkdown(md);
		expect(result).toContain('<table>');
		expect(result).toMatch(/<th[^>]*>A<\/th>/);
		expect(result).toMatch(/<td[^>]*>1<\/td>/);
	});

	it('stripToolCallArtifacts removes complete tool_call blocks', () => {
		const input = 'before <tool_call>{"name":"x","arguments":{}}</tool_call> after';
		expect(stripToolCallArtifacts(input)).toBe('before  after');
	});

	it('stripToolCallArtifacts removes stray closing tag', () => {
		const input = 'partial response </tool_call> more text';
		expect(stripToolCallArtifacts(input)).toBe('partial response  more text');
	});

	it('stripToolCallArtifacts removes stray opening tag', () => {
		const input = 'text <tool_call> followed by prose';
		expect(stripToolCallArtifacts(input)).toBe('text  followed by prose');
	});

	it('stripToolCallArtifacts leaves normal content untouched', () => {
		const input = 'A paragraph with `inline code` and **bold** text.';
		expect(stripToolCallArtifacts(input)).toBe(input);
	});

	it('stripToolCallArtifacts removes <function=...><parameter=...> blocks', () => {
		// The exact leak pattern seen from a misconfigured remote
		// inference server running Qwen3: tool-call tokens rendered
		// into text content instead of the OpenAI tool_calls array.
		const input =
			'before <function=email_summarize_message>' +
			' <parameter=accountId> abc' +
			' <parameter=messageId> 22893' +
			'</function> after';
		expect(stripToolCallArtifacts(input)).toBe('before  after');
	});

	it('stripToolCallArtifacts strips function block that runs to end of string', () => {
		const input = 'here is my plan <function=web_search> <parameter=query> something';
		expect(stripToolCallArtifacts(input)).toBe('here is my plan ');
	});

	it('renderMarkdown strips tool_call XML from rendered output', () => {
		// The exact degradation pattern: model emits tool_call XML in
		// final synthesis content instead of through tool_calls field.
		const md = 'Here is my answer.\n\n<tool_call>\n{"name": "web_search"}\n</tool_call>';
		const result = renderMarkdown(md);
		expect(result).not.toContain('tool_call');
		expect(result).not.toContain('web_search');
		expect(result).toContain('Here is my answer');
	});

	it('renderMarkdown hides trailing unclosed tag during streaming', () => {
		// Reproduces the "</" flicker bug: during streaming the model
		// emits `</tool_call>` character-by-character, and marked keeps
		// opening/closing a partial tag as each char arrives. Stripping
		// the trailing partial tag until `>` arrives keeps the output
		// visually stable.
		const partial1 = 'streaming content <';
		const partial2 = 'streaming content </';
		const partial3 = 'streaming content </t';
		const partial4 = 'streaming content </tool_call';
		// None of these should contain the partial tag in the output
		expect(renderMarkdown(partial1)).not.toContain('&lt;');
		expect(renderMarkdown(partial2)).not.toContain('&lt;');
		expect(renderMarkdown(partial3)).not.toContain('&lt;t');
		expect(renderMarkdown(partial4)).not.toContain('tool_call');
		// But the legitimate prefix remains
		expect(renderMarkdown(partial1)).toContain('streaming content');
		expect(renderMarkdown(partial4)).toContain('streaming content');
	});

	it('renderMarkdown preserves less-than in plain text', () => {
		// `5 < 10` — the `<` is followed by a space, not a tag-name
		// character, so the trailing-tag regex must not match.
		const result = renderMarkdown('5 < 10');
		// marked escapes the `<` to `&lt;` — the content is still there
		expect(result).toContain('5');
		expect(result).toContain('10');
	});

	it('renderMarkdown preserves complete HTML tags in the middle', () => {
		// A complete tag somewhere in the middle should pass through.
		// We only strip trailing unclosed tags at the very end.
		const md = 'text with <strong>emphasis</strong> and more text';
		const result = renderMarkdown(md);
		expect(result).toContain('emphasis');
		expect(result).toContain('more text');
	});

	it('stripMarkdownForTTS produces clean text', () => {
		const md = '## Title\n\n**Bold text** and *italic*.\n\n- Item one\n- Item two';
		const result = stripMarkdownForTTS(md);
		expect(result).toContain('Title');
		expect(result).toContain('Bold text');
		expect(result).toContain('italic');
		expect(result).not.toContain('**');
		expect(result).not.toContain('##');
		expect(result).not.toContain('<');
	});

	it('stripMarkdownForTTS reads tables by column', () => {
		const md =
			'| Board | Price | Rating |\n|---|---|---|\n| ROG Crosshair | $500 | 9.5 |\n| ASRock Pro | $200 | 8.0 |';
		const result = stripMarkdownForTTS(md, true);
		// Should read Price column first, then Rating column
		// "Price. ROG Crosshair: $500. ASRock Pro: $200. Rating. ROG Crosshair: 9.5. ASRock Pro: 8.0."
		expect(result).toContain('Price');
		expect(result).toContain('ROG Crosshair: $500');
		expect(result).toContain('ASRock Pro: $200');
		// Price section should come before Rating section
		expect(result.indexOf('Price')).toBeLessThan(result.indexOf('Rating'));
	});

	it('stripMarkdownForTTS reads tables by row when disabled', () => {
		const md = '| Board | Price |\n|---|---|\n| ROG | $500 |';
		const result = stripMarkdownForTTS(md, false);
		// Should just read row by row
		expect(result).toContain('ROG');
		expect(result).toContain('$500');
	});

	it('stripMarkdownForTTS removes code blocks', () => {
		const md = 'Before code\n\n```js\nconst x = 1;\n```\n\nAfter code';
		const result = stripMarkdownForTTS(md);
		expect(result).toContain('Before code');
		expect(result).toContain('After code');
		expect(result).not.toContain('const x');
	});
});

describe('processCitations', () => {
	const fetched = ['https://alpha.example', 'https://beta.example', 'https://gamma.example'];

	it('numbers cited URLs in appearance order, not fetch order', () => {
		// beta appears before alpha in the prose — it should get [1].
		const text =
			'First point [source](https://beta.example) and then [source](https://alpha.example).';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(citedUrls).toEqual(['https://beta.example', 'https://alpha.example']);
		expect(content).toBe(
			'First point [\\[1\\]](https://beta.example) and then [\\[2\\]](https://alpha.example).'
		);
	});

	it('reuses the same number when a URL is cited more than once', () => {
		const text =
			'[source](https://alpha.example) then [source](https://beta.example) then [ref](https://alpha.example) again.';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(citedUrls).toEqual(['https://alpha.example', 'https://beta.example']);
		expect(content).toContain('[\\[1\\]](https://alpha.example)');
		expect(content).toContain('[\\[2\\]](https://beta.example)');
		// The second alpha reference also becomes [1].
		expect(content.match(/\\\[1\\\]/g)?.length).toBe(2);
	});

	it('numbers citation-anchored links even when the URL was not fetched', () => {
		// The model sometimes cites a URL it only saw in a search snippet.
		// Those links still lead somewhere useful, so they get a citation
		// slot alongside the verified ones.
		const text =
			'Fetched [source](https://alpha.example) and snippet [source](https://random.example).';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(citedUrls).toEqual(['https://alpha.example', 'https://random.example']);
		expect(content).toContain('[\\[1\\]](https://alpha.example)');
		expect(content).toContain('[\\[2\\]](https://random.example)');
	});

	it('keeps prose hyperlinks with non-citation anchor text untouched', () => {
		const text =
			'Verified [source](https://alpha.example) — also see [Wikipedia](https://en.wikipedia.org/wiki/X).';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(citedUrls).toEqual(['https://alpha.example']);
		// Wikipedia link is prose, not a citation, so it stays intact.
		expect(content).toContain('[Wikipedia](https://en.wikipedia.org/wiki/X)');
		expect(content).toContain('[\\[1\\]](https://alpha.example)');
	});

	it('strips citation links whose URL is a breadcrumb display path', () => {
		// Models sometimes copy the snippet breadcrumb form as the URL,
		// e.g. "https://site.com › page › sub". Marked parses only up to
		// the first space, leaving broken link + trailing text in the
		// rendered output. The cleanup pass drops the whole citation.
		const text =
			'NHS list hit 7.75M [source](https://nhscampaign.org › issues › staff-shortages-copy-2). Meanwhile...';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(content).toBe('NHS list hit 7.75M. Meanwhile...');
		expect(citedUrls).toEqual([]);
	});

	it('strips citation links with ellipsis-truncated breadcrumb URLs', () => {
		const text = 'A claim [source](https://example.com › ... › article-slug...). Done.';
		const { content } = processCitations(text, fetched);
		expect(content).toBe('A claim. Done.');
	});

	it('strips a model-written Sources section of [N] stubs', () => {
		const text = [
			'Main answer body with [source](https://alpha.example) inline.',
			'',
			'Sources',
			'',
			'[5]',
			'[3]',
			'[1]',
			'',
			'In short: the real conclusion.'
		].join('\n');
		const { content } = processCitations(text, fetched);
		expect(content).not.toMatch(/^Sources\s*$/m);
		expect(content).not.toMatch(/^\s*\[5\]\s*$/m);
		expect(content).not.toMatch(/^\s*\[3\]\s*$/m);
		expect(content).toContain('In short: the real conclusion.');
		expect(content).toContain('[\\[1\\]](https://alpha.example)');
	});

	it('keeps a "Sources" heading that introduces real prose', () => {
		// If the heading is followed by prose rather than [N] stubs,
		// the stripper leaves it alone — the user may have asked about
		// sources as a topic.
		const text = [
			'Answer body.',
			'',
			'Sources',
			'',
			'Our main sources of funding come from three sectors.'
		].join('\n');
		const { content } = processCitations(text, fetched);
		expect(content).toContain('Sources');
		expect(content).toContain('three sectors');
	});

	it('keeps clean URLs with query strings and fragments intact', () => {
		const text = 'Fact [source](https://alpha.example/page?a=1&b=2#section).';
		const { content, citedUrls } = processCitations(text, [
			'https://alpha.example/page?a=1&b=2#section'
		]);
		expect(citedUrls).toEqual(['https://alpha.example/page?a=1&b=2#section']);
		expect(content).toContain('https://alpha.example/page?a=1&b=2#section');
	});

	it('numbers citation-anchored links even when no URLs were fetched', () => {
		// With an empty fetched list, the anchor-text heuristic is the
		// only signal we have — but it's enough to keep the citation
		// clickable and numbered.
		const text = 'Claim [source](https://random.example) end.';
		const { content, citedUrls } = processCitations(text, []);
		expect(content).toBe('Claim [\\[1\\]](https://random.example) end.');
		expect(citedUrls).toEqual(['https://random.example']);
	});

	it('is idempotent — a second pass is a no-op', () => {
		const text = 'Citing [source](https://alpha.example).';
		const first = processCitations(text, fetched);
		const second = processCitations(first.content, fetched);
		expect(second.content).toBe(first.content);
		expect(second.citedUrls).toEqual(first.citedUrls);
	});

	it('returns the input unchanged when no citations are present', () => {
		const text = 'Just prose with no links.';
		const { content, citedUrls } = processCitations(text, fetched);
		expect(content).toBe(text);
		expect(citedUrls).toEqual([]);
	});

	it('produces clickable anchors when rendered through renderMarkdown', () => {
		const { content } = processCitations(
			'See [source](https://alpha.example) for details.',
			fetched
		);
		const html = renderMarkdown(content);
		expect(html).toContain('href="https://alpha.example"');
		expect(html).toContain('[1]');
	});
});
