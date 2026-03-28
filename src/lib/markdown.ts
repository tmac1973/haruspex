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

export function stripMarkdown(text: string): string {
	let cleaned = convertThinkingBlocks(text);
	// Remove thinking blocks entirely for TTS
	cleaned = cleaned.replace(/<details[\s\S]*?<\/details>/g, '');
	// Remove code blocks
	cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
	// Remove inline code
	cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
	// Remove headings markers
	cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
	// Remove bold/italic markers
	cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
	cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
	cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
	cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
	// Remove links — keep text
	cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
	// Remove images
	cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
	// Remove horizontal rules
	cleaned = cleaned.replace(/^[-*_]{3,}$/gm, '');
	// Remove bullet/list markers
	cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, '');
	cleaned = cleaned.replace(/^[\s]*\d+\.\s+/gm, '');
	// Remove table formatting
	cleaned = cleaned.replace(/\|/g, ' ');
	cleaned = cleaned.replace(/^[\s]*[-:]+[\s]*$/gm, '');
	// Collapse whitespace
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
	return cleaned.trim();
}

export function renderMarkdown(text: string): string {
	const withThinking = convertThinkingBlocks(text);
	return marked.parse(withThinking) as string;
}
