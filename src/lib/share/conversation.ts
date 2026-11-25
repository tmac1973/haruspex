/**
 * A Chat conversation as the user sees it, for Email and Print: the typed
 * messages and the answers, without reasoning, tool steps, compaction
 * summaries or task notices.
 */
import { messageText, type ChatMessage, type MessageContentPart } from '#lib/api.ts';
import { isSummaryMessage } from '#lib/agent/summaryMessage.ts';
import { splitAttachedAudio } from '#lib/audio/attached.ts';
import { renderMarkdown, splitThinkChannels } from '#lib/markdown.ts';
import { resolvedImages } from '#lib/images/figure.ts';
import { typedText } from '#lib/skills/content.ts';
import { isTaskNotice } from '#lib/tasks/noticeText.ts';

export interface Turn {
	role: 'user' | 'assistant';
	/** Markdown for an answer; what was typed for a user message. */
	text: string;
	/** Pictures the user attached (data or app URLs). */
	images: string[];
}

/**
 * The answer in an assistant message, as Chat shows it: the reasoning left
 * out, unless the whole message is reasoning (then that is the answer).
 */
export function answerText(content: string): string {
	const { reasoning, answer } = splitThinkChannels(content);
	return (answer.trim() === '' ? reasoning : answer).trim();
}

function attachedImages(m: ChatMessage): string[] {
	if (typeof m.content === 'string') return [];
	return (m.content as MessageContentPart[])
		.filter((p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url')
		.map((p) => p.image_url.url);
}

/** The turns worth sharing, in order. */
export function conversationTurns(messages: readonly ChatMessage[]): Turn[] {
	const turns: Turn[] = [];
	for (const m of messages) {
		if (isSummaryMessage(m)) continue;
		const raw = messageText(m.content);
		if (m.role === 'user') {
			if (isTaskNotice(raw)) continue;
			const text = splitAttachedAudio(typedText(raw)).text.trim();
			const images = attachedImages(m);
			if (text || images.length) turns.push({ role: 'user', text, images });
		} else if (m.role === 'assistant') {
			const text = answerText(raw);
			if (text) turns.push({ role: 'assistant', text, images: [] });
		}
	}
	return turns;
}

const label = (t: Turn) => (t.role === 'user' ? 'You' : 'Haruspex');

/**
 * The conversation as Markdown, for an email body: each turn under who said
 * it, the pictures the user attached under their message.
 */
export function conversationMarkdown(messages: readonly ChatMessage[]): string {
	return conversationTurns(messages)
		.map((t) => {
			const pics = t.images.map((u) => `![Attached picture](${u})`).join('\n');
			return [`**${label(t)}:**`, t.text, pics].filter(Boolean).join('\n\n');
		})
		.join('\n\n');
}

const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>');

/** The conversation as HTML, for printing: each turn under who said it. */
export function conversationHtml(title: string, messages: readonly ChatMessage[]): string {
	const parts = [`<h1>${esc(title)}</h1>`];
	for (const t of conversationTurns(messages)) {
		const body =
			t.role === 'user'
				? t.images.map((u) => `<img src="${esc(u)}" alt="Attached">`).join('') +
					(t.text ? `<p>${esc(t.text)}</p>` : '')
				: renderMarkdown(t.text, resolvedImages);
		parts.push(`<section class="turn" data-role="${t.role}"><h2>${label(t)}</h2>${body}</section>`);
	}
	return parts.join('\n');
}
