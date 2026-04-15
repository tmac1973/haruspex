import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';

// Register only the languages we need to keep the bundle small
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

const marked = new Marked({
	renderer: {
		code({ text, lang }: { text: string; lang?: string }) {
			const language = lang && hljs.getLanguage(lang) ? lang : undefined;
			const highlighted = language ? hljs.highlight(text, { language }).value : escapeHtml(text);

			const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';

			return `<div class="code-block">
				<div class="code-header">
					${langLabel}
					<button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">Copy</button>
				</div>
				<pre><code class="${language ? `hljs language-${language}` : ''}">${highlighted}</code></pre>
			</div>`;
		}
	}
});

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Local models occasionally emit GFM tables with a malformed separator row —
 * e.g. `| :--- | :--- | :--- | :--- :--- |` (4 cells for a 5-column header,
 * because two `:---` tokens got crammed into one cell with a missing pipe).
 * Marked is strict about table structure and falls back to rendering the
 * whole block as plain text when this happens. This preprocessor detects
 * that case and rewrites the separator row to match the header column count.
 */
function fixMalformedTables(text: string): string {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length - 1; i++) {
		const header = lines[i].trim();
		const sep = lines[i + 1].trim();

		// Header must be pipe-delimited on both sides with ≥2 columns
		if (!header.startsWith('|') || !header.endsWith('|')) continue;
		const headerCells = header.slice(1, -1).split('|').length;
		if (headerCells < 2) continue;

		// Candidate separator: only `:`, `-`, `|`, whitespace — and contains a dash
		if (!/^[\s|:-]+$/.test(sep) || !/-/.test(sep)) continue;

		// Strict separator shape that marked would accept
		const wellFormed = /^\|\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|$/.test(sep);

		// Extract the alignment tokens present (to decide the rebuilt shape)
		const alignTokens = sep.match(/:?-{2,}:?/g) || [];

		if (wellFormed && alignTokens.length === headerCells) continue;

		// Rebuild: use the first alignment seen, or default to left-aligned
		const align = alignTokens[0] || ':---';
		lines[i + 1] = '| ' + Array(headerCells).fill(align).join(' | ') + ' |';
	}
	return lines.join('\n');
}

/**
 * Remove `<tool_call>` XML artifacts from model chat content.
 *
 * Local models (especially Qwen 9B after a long tool-calling chain)
 * sometimes emit a tool call as raw text content instead of through the
 * structured `tool_calls` field in the API response. When the JSON
 * inside is malformed or truncated, the agent loop's parser swallows
 * the error and the text ends up in the final synthesis, polluting the
 * rendered output and the saved conversation history.
 *
 * This helper strips three shapes in order:
 *   1. Complete `<tool_call>...</tool_call>` blocks
 *   2. Stray closing `</tool_call>` tags with no matching opener
 *   3. Stray opening `<tool_call>` tags with no matching closer
 *
 * Used at both commit time (onComplete in the chat store) and render
 * time (via renderMarkdown) so the artifacts never reach the DOM and
 * never get sent back to the model as history on the next turn.
 */
export function stripToolCallArtifacts(text: string): string {
	let out = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
	out = out.replace(/<\/tool_call>/g, '');
	out = out.replace(/<tool_call>/g, '');
	// Also strip <function=name>...<parameter=...>... blocks that
	// some remote inference servers emit instead of native tool_calls
	// JSON. Matches the `extractFunctionStyleToolCalls` grammar in
	// parser.ts: a function block runs from <function=...> until the
	// next <function=...>, a </function>, or end of string.
	out = out.replace(/<function=[a-zA-Z_][\w]*\s*>[\s\S]*?(?:<\/function>|(?=<function=)|$)/g, '');
	return out;
}

/**
 * Render-time content sanitizer. On top of `stripToolCallArtifacts`,
 * hides any trailing unclosed HTML-like tag (e.g. `</`, `</t`, `<div`)
 * at the end of the input.
 *
 * This addresses a specific streaming UX bug: when the model emits a
 * `</tool_call>` tag character-by-character, marked's HTML parser sees
 * a growing partial tag (`</` → `</t` → `</to` → …) and flickers it
 * in and out of the DOM as each chunk arrives. Stripping the trailing
 * partial tag until a closing `>` arrives keeps the stream visually
 * stable. Legitimate HTML in the middle of the content is untouched;
 * only a tag at the very end without its closing `>` gets hidden.
 */
function sanitizeForRender(text: string): string {
	let out = stripToolCallArtifacts(text);
	// Matches `<`, `</`, `<tag`, `</tag`, etc. at the very end of the
	// string. Requires at least a `<` and no `>` after it. The tag-name
	// character class excludes space so plain text like `5 < 10` isn't
	// matched.
	out = out.replace(/<\/?[a-zA-Z0-9_-]*$/, '');
	return out;
}

function convertThinkingBlocks(text: string): string {
	return text.replace(/<think>([\s\S]*?)<\/think>/g, (_match, content: string) => {
		const trimmed = content.trim();
		if (!trimmed) return '';
		return `<details class="thinking-block"><summary>Thinking...</summary>\n\n${trimmed}\n\n</details>\n\n`;
	});
}

function convertTableToColumnFirst(tableHtml: string): string {
	// Parse table into a 2D grid
	const rows: string[][] = [];
	const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];

	for (const rowHtml of rowMatches) {
		const cells: string[] = [];
		const cellMatches = rowHtml.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
		for (const cellHtml of cellMatches) {
			const text = cellHtml.replace(/<[^>]+>/g, '').trim();
			cells.push(text);
		}
		if (cells.length > 0) {
			rows.push(cells);
		}
	}

	if (rows.length < 2 || rows[0].length < 2) {
		// Too small to reorder — just flatten
		return rows.map((r) => r.join(', ')).join('. ');
	}

	const headers = rows[0]; // Column headers
	const dataRows = rows.slice(1);
	const numCols = headers.length;
	const parts: string[] = [];

	// Read column by column (skipping column 0 which is the row label)
	for (let col = 1; col < numCols; col++) {
		parts.push(`${headers[col]}.`);
		for (const row of dataRows) {
			const label = row[0] || '';
			const value = row[col] || '';
			if (label && value) {
				parts.push(`${label}: ${value}.`);
			}
		}
	}

	return parts.join(' ');
}

export function stripMarkdownForTTS(text: string, readTablesByColumn = true): string {
	const html = marked.parse(fixMalformedTables(convertThinkingBlocks(text))) as string;

	// Remove thinking blocks
	let cleaned = html.replace(/<details[\s\S]*?<\/details>/g, '');
	// Remove code blocks entirely
	cleaned = cleaned.replace(/<div class="code-block">[\s\S]*?<\/div>\s*<\/div>/g, '');
	cleaned = cleaned.replace(/<pre[\s\S]*?<\/pre>/g, '');

	// Convert tables to column-first reading order
	if (readTablesByColumn) {
		cleaned = cleaned.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
			return ' ' + convertTableToColumnFirst(tableHtml) + ' ';
		});
	}

	// Convert block elements to pauses before stripping tags
	cleaned = cleaned.replace(/<\/h[1-6]>/g, '.\n\n');
	cleaned = cleaned.replace(/<\/p>/g, '.\n');
	cleaned = cleaned.replace(/<\/li>/g, '.\n');
	cleaned = cleaned.replace(/<\/tr>/g, '.\n');
	cleaned = cleaned.replace(/<br\s*\/?>/g, '.\n');
	// Remove all HTML tags, keeping text content
	cleaned = cleaned.replace(/<[^>]+>/g, ' ');
	// Decode HTML entities
	cleaned = cleaned.replace(/&amp;/g, '&');
	cleaned = cleaned.replace(/&lt;/g, '<');
	cleaned = cleaned.replace(/&gt;/g, '>');
	cleaned = cleaned.replace(/&quot;/g, '"');
	cleaned = cleaned.replace(/&#39;/g, "'");
	cleaned = cleaned.replace(/&nbsp;/g, ' ');
	// Remove URLs
	cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
	// Clean up double periods
	cleaned = cleaned.replace(/\.{2,}/g, '.');
	cleaned = cleaned.replace(/\.\s*\./g, '.');
	// Remove emojis
	cleaned = cleaned.replace(/\p{Emoji_Presentation}/gu, '');
	cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '');
	// Collapse whitespace
	cleaned = cleaned.replace(/\s+/g, ' ');
	return cleaned.trim();
}

/**
 * Rewrite inline citations the model emitted as markdown links into
 * numbered references, and return the ordered list of cited URLs.
 *
 * The model is prompted to cite facts with a markdown link pointing at
 * a URL it fetched this turn: `...16 GB of RAM [source](https://example.com)`.
 * Using the real URL as the citation target — instead of asking the
 * model to track a `[N]` → source mapping in its head — removes the
 * main failure mode small local models hit: inventing out-of-range
 * numbers when they want to look authoritative.
 *
 * A link counts as a citation when *either* is true:
 *   - its URL appears in `fetchedUrls` (the model read that page), or
 *   - its anchor text reads as a citation marker (the literal word
 *     "source" / "ref" / "cite", or a bare/bracketed number).
 *
 * The anchor-text rule keeps citations the model emitted for URLs it
 * only saw in search snippets — those links are still useful, so we'd
 * rather include them than silently drop them. Every citation is
 * numbered sequentially in first-appearance order and added to
 * `citedUrls`; the chip row below the reply renders the same list in
 * the same order, so clicking `[3]` opens the third chip.
 *
 * Links whose anchor is arbitrary prose (e.g. `[Wikipedia](...)`) and
 * whose URL wasn't fetched pass through unchanged — ordinary outbound
 * hyperlinks, not citations.
 *
 * Idempotent: running the same text through twice yields the same
 * output, because `[\[N\]](url)` still reads as a citation anchor and
 * re-maps to the same slot.
 */
export interface ProcessedCitations {
	content: string;
	citedUrls: string[];
}

// Matches `[anchor](url)` where the anchor may contain escape sequences
// like `\[` / `\]` (so already-numbered citations with `[\[1\]]` anchors
// round-trip cleanly on a second pass) and the URL contains no whitespace
// or closing paren. Does not support escaped parens in URLs — unusual in
// practice, and marked's own parser has the same limitation.
const MARKDOWN_LINK_RE = /\[((?:\\.|[^\]])*)\]\(([^)\s]+)\)/g;

// Permissive variant that also matches URLs containing whitespace or
// other non-URL characters — used only for the cleanup pass below,
// where we look for citation-style links whose URL is a malformed
// breadcrumb rather than a real URL. Captures one optional leading
// space so stripping consumes the gap before the citation marker.
const MALFORMED_CITATION_RE = /( )?\[((?:\\.|[^\]])*)\]\(([^)]+)\)/g;

// Characters that should never appear inside a real URL but reliably
// appear in search-result breadcrumb display paths — the form some
// engines render as `https://site.com › section › page…`. When a
// citation's "URL" contains any of these, the model almost certainly
// copied the snippet's display line rather than the real href.
const BREADCRUMB_URL_SIGNAL_RE = /[\s›…]|\.\.\./;

// Anchor-text patterns that signal "this is a citation" rather than
// "this is prose with a hyperlink". Matches the literal word "source" /
// "src" / "ref" / "cite" / "citation", a bare number, or a bracketed /
// escaped-bracketed number. Case-insensitive and whitespace-tolerant.
const CITATION_ANCHOR_RE =
	/^\s*(?:source|src|ref|refs|cite|citation|citations|\d+|\\?\[\d+\\?\])\s*$/i;

// Heading line that introduces a bibliography / reference section.
// Matches common markdown forms: `## Sources`, `**References**`,
// `Sources:`, a plain `Sources` line, etc.
const SOURCES_HEADING_RE =
	/^(?:#{1,6}\s+)?(?:\*\*\s*)?(?:sources?|references?|bibliography|citations?)(?:\s*\*\*)?:?\s*$/i;

// Standalone `[N]` reference stub — a line containing nothing but a
// bracketed number (optionally preceded by a list marker). Small local
// models emit these as bibliography entries even though no URLs are
// attached; they render as meaningless `[5]` text in the output.
const REFERENCE_STUB_RE = /^\s*(?:[-*]\s+)?\[\d+\]\s*$/;

/**
 * Remove model-authored bibliography stubs from the tail of an answer.
 *
 * Small local models sometimes append a "Sources" or "References"
 * heading followed by lines like `[5]`, `[3]`, `[1]` — a training-data
 * artifact from academic-style writing. Haruspex already renders the
 * real source list as the chip row below the message, so these stubs
 * are at best duplicative and at worst misleading (the brackets have
 * no URLs behind them, so they read as broken references).
 *
 * Stripping is conservative: only standalone `[N]` lines go, and the
 * "Sources" heading is dropped only when it's immediately followed by
 * such stubs (so we never strip a heading that introduces real prose
 * about sources).
 */
function stripReferenceStubs(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (REFERENCE_STUB_RE.test(line)) {
			i++;
			continue;
		}
		if (SOURCES_HEADING_RE.test(line)) {
			// Peek past any blank lines to see if the next substantive
			// line is a stub. If so, drop the heading and the blanks.
			let j = i + 1;
			while (j < lines.length && /^\s*$/.test(lines[j])) j++;
			if (j < lines.length && REFERENCE_STUB_RE.test(lines[j])) {
				// Also tidy a trailing blank left in the output so we don't
				// leave a gap where the section used to start.
				while (out.length > 0 && /^\s*$/.test(out[out.length - 1])) out.pop();
				i = j;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join('\n');
}

function isCitationLink(anchor: string, url: string, fetchedUrls: readonly string[]): boolean {
	return fetchedUrls.includes(url) || CITATION_ANCHOR_RE.test(anchor);
}

export function processCitations(text: string, fetchedUrls: readonly string[]): ProcessedCitations {
	if (!text) return { content: text, citedUrls: [] };

	// First pass: walk every link and record the ones that count as
	// citations, in the order their URL first appears. Linear lookup
	// into fetchedUrls is fine — a typical turn fetches well under 20
	// URLs.
	const urlToIndex = new Map<string, number>();
	const citedUrls: string[] = [];
	for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
		const anchor = match[1];
		const url = match[2];
		if (!isCitationLink(anchor, url, fetchedUrls)) continue;
		if (urlToIndex.has(url)) continue;
		urlToIndex.set(url, citedUrls.length + 1);
		citedUrls.push(url);
	}

	// Second pass: rewrite citation links to numbered anchors. The
	// `\[N\]` escaping keeps marked from treating the bracket as a
	// footnote start. Non-citation links (prose anchors, non-fetched
	// URLs) pass through unchanged.
	let content =
		citedUrls.length === 0
			? text
			: text.replace(MARKDOWN_LINK_RE, (match, _anchor: string, url: string) => {
					const n = urlToIndex.get(url);
					if (n === undefined) return match;
					return `[\\[${n}\\]](${url})`;
				});

	// Third pass: strip citation-anchored links whose URL is clearly a
	// breadcrumb display path, not a real URL. Marked's parser would
	// otherwise render only the prefix up to the first space as a link
	// and leave the rest as trailing plain text — giving the reader a
	// clickable fragment that points nowhere useful. Dropping the whole
	// citation (and its preceding space) keeps the prose readable
	// without pretending the model cited a real page.
	content = content.replace(
		MALFORMED_CITATION_RE,
		(match, leadingSpace: string | undefined, anchor: string, url: string) => {
			if (!BREADCRUMB_URL_SIGNAL_RE.test(url)) return match;
			if (!CITATION_ANCHOR_RE.test(anchor)) return match;
			void leadingSpace; // intentionally consumed
			return '';
		}
	);

	// Fourth pass: remove model-authored "Sources" / "References"
	// sections that contain only `[N]` stub entries. The chip row
	// below the reply is the canonical source list — a second,
	// stubby one inline is noise.
	content = stripReferenceStubs(content);

	return { content, citedUrls };
}

export function renderMarkdown(text: string): string {
	const sanitized = sanitizeForRender(text);
	const withThinking = convertThinkingBlocks(sanitized);
	const withFixedTables = fixMalformedTables(withThinking);
	return marked.parse(withFixedTables) as string;
}
