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
	const html = marked.parse(convertThinkingBlocks(text)) as string;

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
	const withThinking = convertThinkingBlocks(text);
	return marked.parse(withThinking) as string;
}
