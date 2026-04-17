import { type ChatMessage, messageText } from '$lib/api';
import { getResponseFormatPrompt, hasEnabledEmailAccount } from '$lib/stores/settings';

const REVIEW_PATTERNS =
	/\b(best|top\s+\d|recommend|review|comparison|compare|vs\.?|versus|worth|which\s+(?:one|should)|budget|premium|upgrade)\b/i;

function looksLikeReviewQuery(content: string): boolean {
	return REVIEW_PATTERNS.test(content);
}

const FILE_OUTPUT_PATTERNS =
	/\b(pdf|docx|xlsx|odt|ods|odp|pptx|spreadsheet|word\s+doc(?:ument)?|excel\s+(?:file|spreadsheet|sheet)|open\s*document|libreoffice|presentation|powerpoint|slide\s*deck)\b/i;

export function looksLikeFileOutputRequest(content: string): boolean {
	return FILE_OUTPUT_PATTERNS.test(content);
}

export function buildSystemPrompt(workingDir: string | null): ChatMessage {
	const today = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	const fsSection = workingDir
		? `

FILESYSTEM ACCESS:
- Working directory: ${workingDir}
- Use fs_list_dir first to see what files exist before reading specific files.
- Only use filesystem tools when the user explicitly asks to work with files.
- When the user asks you to create a file (PDF, docx, xlsx, etc.), do your research and call the appropriate fs_write_* tool with complete content IN THE SAME TURN. Do not dump the content as a chat message instead.`
		: '';

	const emailSection = hasEnabledEmailAccount()
		? `

EMAIL INTEGRATION:
- The user has connected email accounts. Only use email tools when explicitly asked about email.
- Use email_list_recent first, then email_summarize_message on the 3-5 most important messages. Skip newsletters and automated notifications unless asked.
- Use email_read_full only when the user needs verbatim text.`
		: '';

	return {
		role: 'system',
		content: `You are Haruspex, a helpful, private AI assistant running on the user's computer.

Today's date is ${today}. Your training data may be outdated — search before answering questions about products, current events, pricing, or recommendations.

SEARCH RULES:
- Search before answering factual questions. Use the user's exact terms.
- Use fetch_url on 2-4 of the most relevant results before answering.
- Only cite sources you actually fetched. Do not cite URLs from search snippets alone.
- For reviews or "best of" questions, include Reddit alongside review sites.

CITATIONS:
- Cite facts from the web inline as [source](URL). Use the URL from the [Source: <url>] header on each fetched page.
- Each [source](URL) must point to the page where that specific claim appeared.
- Do NOT append a Sources or References section — the UI renders citations automatically.${fsSection}${emailSection}

Be concise, accurate, and helpful. When in doubt, search.

${getResponseFormatPrompt()}`
	};
}

/**
 * Augment the messages array with per-turn hints based on the user's
 * message content and current settings. Appends hint text to the last
 * user message. Returns the modified array.
 */
export function injectMessageHints(
	messages: ChatMessage[],
	opts: {
		workingDir: string | null;
		exhaustiveResearch: boolean;
	}
): ChatMessage[] {
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== 'user') return messages;

	const hints: string[] = [];
	const lastText = messageText(lastMsg.content);

	if (looksLikeReviewQuery(lastText)) {
		hints.push('Include Reddit as a source.');
	}

	if (opts.workingDir && looksLikeFileOutputRequest(lastText)) {
		hints.push(
			'You must create the requested file DURING THIS TURN. Do your research, ' +
				'synthesize the content, and then call fs_write_pdf / fs_write_docx / ' +
				'fs_write_xlsx (whichever matches the request) with the full content as ' +
				'your final action. Do NOT paste the report as a chat message and ' +
				'expect the user to ask again in a follow-up — that wastes a round trip ' +
				'and risks running out of context on the retry. After the write tool ' +
				'succeeds, respond with a brief confirmation and the file path.'
		);
	}

	if (opts.exhaustiveResearch) {
		hints.push(
			'Research this thoroughly. Perform multiple searches from different angles. ' +
				'Read at least 4-6 sources before answering. Include diverse viewpoints. ' +
				'For every source you read, use research_url (not fetch_url) and pass a ' +
				'specific focus describing what you are looking for on that page — for ' +
				'example "pricing tiers and free plan limits", "criticisms or downsides", ' +
				'or "verbatim claims about deployment latency". Each call processes one URL.'
		);
	}

	if (hints.length === 0) return messages;

	const suffix = '\n\n(' + hints.join(' ') + ')';
	const result = [...messages];
	if (typeof lastMsg.content === 'string') {
		result[result.length - 1] = { ...lastMsg, content: lastMsg.content + suffix };
	} else {
		const parts = [...lastMsg.content];
		const textIdx = parts.findIndex((p) => p.type === 'text');
		if (textIdx >= 0) {
			const textPart = parts[textIdx] as { type: 'text'; text: string };
			parts[textIdx] = { type: 'text', text: textPart.text + suffix };
		} else {
			parts.push({ type: 'text', text: suffix.trim() });
		}
		result[result.length - 1] = { ...lastMsg, content: parts };
	}
	return result;
}
