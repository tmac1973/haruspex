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

export function renderMarkdown(text: string): string {
	const sanitized = sanitizeForRender(text);
	const withThinking = convertThinkingBlocks(sanitized);
	const withFixedTables = fixMalformedTables(withThinking);
	return marked.parse(withFixedTables) as string;
}
