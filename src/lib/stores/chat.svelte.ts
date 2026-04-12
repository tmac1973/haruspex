import { type ChatMessage, type Usage, ApiError, messageText } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { shouldCompact, compactConversation } from '$lib/agent/compaction';
import {
	getActiveContextSize,
	getResponseFormatPrompt,
	getSettings,
	hasEnabledEmailAccount
} from '$lib/stores/settings';
import { stripToolCallArtifacts } from '$lib/markdown';
import {
	getContextUsage,
	updateContextUsage,
	resetContextUsage,
	setContextUsage
} from '$lib/stores/context.svelte';
import { invoke } from '@tauri-apps/api/core';

const REVIEW_PATTERNS =
	/\b(best|top\s+\d|recommend|review|comparison|compare|vs\.?|versus|worth|which\s+(?:one|should)|budget|premium|upgrade)\b/i;

function looksLikeReviewQuery(content: string): boolean {
	return REVIEW_PATTERNS.test(content);
}

// Matches user requests that imply a file output (as opposed to a chat
// answer). Hits on explicit file-type mentions like "PDF", "docx", etc.
// Used in `sendMessage` to attach an extra per-turn reminder that the
// model must call the appropriate fs_write_* tool during the same turn.
const FILE_OUTPUT_PATTERNS =
	/\b(pdf|docx|xlsx|odt|ods|odp|pptx|spreadsheet|word\s+doc(?:ument)?|excel\s+(?:file|spreadsheet|sheet)|open\s*document|libreoffice|presentation|powerpoint|slide\s*deck)\b/i;

function looksLikeFileOutputRequest(content: string): boolean {
	return FILE_OUTPUT_PATTERNS.test(content);
}

function buildSystemPrompt(workingDir: string | null): ChatMessage {
	const today = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	const fsSection = workingDir
		? `

FILESYSTEM ACCESS:
- A working directory is active: ${workingDir}
- You have filesystem tools to read and write files in this directory.
- Use fs_list_dir first (with path ".") to see what files are available before reading specific files.
- Use fs_read_text for text files (txt, md, csv, json, sh, yml, etc.).
- Use fs_read_pdf for simple text-based PDFs — fast and efficient. For form PDFs (tax forms like W-2, 1040, invoices, receipts, applications), scanned documents, or any PDF where fs_read_pdf produced garbled or incomplete output, use fs_read_pdf_pages instead. fs_read_pdf_pages renders each page as an image so you can read it visually — this handles form layouts, checkboxes, and custom fonts correctly.
- CRITICAL: When using fs_read_pdf_pages on multiple PDFs, process them ONE AT A TIME. Load the first PDF with fs_read_pdf_pages, describe/summarize its contents in your next response, then in the FOLLOWING turn call fs_read_pdf_pages for the next PDF. Loading multiple PDFs as images in the same turn exhausts the vision model's context and crashes inference.
- Use fs_read_docx for Microsoft Word (.docx) files.
- Use fs_read_xlsx for Excel spreadsheets (.xlsx) — returns CSV-formatted text. Specify the sheet name if the workbook has multiple sheets.
- Use fs_read_image for image files (png, jpg, webp). After calling it, the image becomes part of your context and you can see it with your vision capability — describe it or answer questions about it in your next response.
- Only use filesystem tools when the user explicitly asks you to work with files. Do not proactively read files.
- You can create text files with fs_write_text (including bash scripts, markdown, csv, json).
- Use fs_write_docx to create a Word document from markdown-style content (# for headings).
- Use fs_write_odt to create an OpenDocument Text file — the native format of LibreOffice Writer. Only use this when the user specifically asks for an ODT / OpenDocument / LibreOffice-native file; otherwise fs_write_docx is the default (LibreOffice opens .docx fine).
- Use fs_write_pdf to create a PDF from markdown-style content (# for headings). Use for printable reports; use fs_write_docx when the user wants an editable doc.
- Use fs_write_xlsx to create an Excel spreadsheet from structured sheet data.
- Use fs_write_ods to create an OpenDocument Spreadsheet — the native format of LibreOffice Calc. Only use this when the user specifically asks for an ODS / OpenDocument / LibreOffice-native spreadsheet; otherwise fs_write_xlsx is the default.
- Use fs_write_pptx to create a PowerPoint presentation when the user asks for a slide deck, briefing, or presentation. Each slide has a short title plus one of: a bullet list (content layout, default), or a big centered title for a section divider (layout: "section", optional subtitle). Bullets can be nested — pass an object { text: "...", level: 1 } for a sub-bullet (levels 0-2). You can attach one image per slide via image: "relative/path.png" (png/jpg/gif from the working directory); bullets shift to the left half when an image is present. Keep titles to ~8 words and bullets to ~10 words each; aim for 3-6 top-level bullets per slide. Longer text overflows.
- To source images for a presentation or report you have two tools: image_search queries Wikimedia Commons (all results are freely-licensed — safe for generic or stock-style imagery); fetch_url_images scans a specific web page for its embedded <img> URLs (use this when the user wants a product photo from a manufacturer's own site, a chart from a review, etc.). Either way, call fs_download_url with the chosen URL and a relative path inside the working directory to actually save the bytes. Then reference the local path in fs_write_pptx via the slide's image field. Typical motherboard-deck flow: web_search for the product → fetch_url_images on the manufacturer product page → pick a likely product shot by alt text → fs_download_url to images/mobo-hero.png → fs_write_pptx with image: "images/mobo-hero.png". Note that fetch_url_images results are usually copyrighted — use them when the user specifically asks for vendor content; prefer image_search when they just want "a picture of X".
- Use fs_write_odp to create an OpenDocument Presentation (LibreOffice Impress native format) with the same slide API (layouts, nested bullets, images). Only use this when the user specifically asks for an ODP / OpenDocument / LibreOffice-native presentation; otherwise fs_write_pptx is the default.
- Use fs_edit_text for small targeted changes — it replaces exactly one occurrence of old_str with new_str.
- You cannot delete or move files. If the user wants to remove a file, tell them to do it manually.
- When creating bash or shell scripts, include a shebang line (#!/bin/bash or #!/usr/bin/env bash) and remind the user they must chmod +x and run the script themselves — you cannot execute scripts.
- CRITICAL — FILE-OUTPUT REQUESTS: When the user asks you to create a file (PDF, docx, xlsx, or a text file) — e.g. "create a PDF report on X", "write a summary to a file", "export this as a docx" — the file-write is the FINAL action of THIS turn, not a follow-up. Do your research, synthesize the content, and call the appropriate fs_write_* tool with the complete content IN THE SAME TURN. Then respond briefly in chat with the file path. Do NOT end the turn by dumping the report as a chat message and waiting for the user to ask again — that wastes a whole round trip and risks running out of context on the retry. If a PDF was requested, you MUST call fs_write_pdf before finishing.
- FILE OVERWRITE PROTECTION: Write tools (fs_write_*, fs_download_url) will refuse to silently overwrite an existing file. If you try to write to a path that already exists from a previous turn or user action, Haruspex shows the user an interactive prompt — they pick Overwrite, Keep both (auto-appends -2/-3 to the filename), or Cancel. If they cancel, the tool returns an error containing "User canceled". When you see that error: STOP what you were doing, briefly explain to the user that the target file already exists, and ASK them how they'd like to proceed. Do NOT silently retry with a different filename and do NOT keep looping — the user wants to be in the loop on this decision. If you legitimately need to overwrite a file (e.g. iterating on content you created earlier this same turn), that's handled automatically — files you wrote earlier in the current turn can be rewritten freely without triggering the prompt.
- PRESENTATION WITH IMAGES WORKFLOW: When the user asks for a slide deck that includes images, you are expected to handle the full pipeline in a single turn. Work in this exact order and DO NOT re-research facts after you've started downloading:
  Step 1. Quick research pass: 3–6 web_search / fetch_url calls max to gather the facts you need for each slide. Once you have enough information to populate every slide, STOP researching.
  Step 2. For each image you need: try image_search first (keyless Wikimedia Commons, safe licensing). If Commons returns nothing useful for a specific product or topic, pick one of the pages from step 1 and call fetch_url_images on it to get the image URLs actually present on that page. Look for large images with descriptive alt text.
  Step 3. For each chosen image: call fs_download_url with a short local path like "images/slide-2.png". One image per slide is plenty; you don't need one for every slide.
  Step 4. Finally, call fs_write_pptx (or fs_write_odp) with ALL slides at once. Reference downloaded images via the slide's "image" field.
  Step 5. If you cannot find usable images after a reasonable effort (image_search returned nothing AND fetch_url_images didn't yield a clear candidate), WRITE THE PRESENTATION WITHOUT IMAGES anyway. A finished text-only deck is vastly more useful to the user than no deck. You can tell them in your confirmation message that images weren't available for certain slides.
  Step 6. Do NOT announce what you're about to do and then stop. Phrases like "Now I'll create the presentation:" followed by no tool call are a failure. Either call the write tool or don't mention it.
  Step 7. Do NOT re-research in a follow-up turn when the user points out the file is missing. If you see in the conversation that a file was supposed to be created and wasn't, your first action in the new turn must be to call fs_write_pptx / fs_write_odp with the content from the previous research.`
		: '';

	const emailSection = hasEnabledEmailAccount()
		? `

EMAIL INTEGRATION:
- The user has connected at least one email account. You have three email tools: email_list_recent, email_summarize_message, email_read_full.
- Only call email_* tools when the user has explicitly asked about email ("summarize my inbox", "any emails from X today?", "read the email from Y"). Never proactively check email.
- Respect the scope the user asked for. "Recent email" means the last few hours unless they specify otherwise. Pass an appropriate hours value (e.g. 4 for "recent", 24 for "today", 168 for "this week") to email_list_recent.
- MULTI-ACCOUNT: the user may have more than one email account enabled. Each listing includes an accountLabel ("Work Gmail", "Personal") alongside the opaque accountId. For generic requests ("summarize my email"), OMIT the account_id parameter — email_list_recent will fan out across every enabled account and merge results by date. Only pass account_id when the user explicitly names an account; in that case you can use either the label from a previous listing or the exact label the user said. When presenting a multi-account digest, group messages by accountLabel (one heading per account) so the user can see which account each message came from. Do not fabricate accountLabels — only use values you have seen in an actual listing response.
- The default max_results of 25 is right for most single-day requests ("recent", "today"). For "this week" or similar multi-day windows you may raise it to 50. The listing size is NOT the digest size: you are expected to filter the listing down to 3-5 important messages and only summarize those. A bigger listing helps you see the noise you can skip, not more work you need to do.
- After listing, pick the 3-5 most important messages and call email_summarize_message on those. Importance signals: personal senders over automated systems, unread / starred / urgent-looking subjects, anything from known-important domains, anything directly addressed to the user rather than a list. Skip newsletters, promotions, automated notifications, receipts, and calendar invites unless the user specifically asked about them.
- Do NOT call email_summarize_message on every message in the listing. That's slow and wasteful, and the digest is more useful when you've filtered out the noise yourself.
- Use email_read_full ONLY when the user explicitly asked to see verbatim text, you need to quote a specific phrase, or a previous summary left something ambiguous. It's the escape hatch, not the default.
- When producing the final digest: start with a one-sentence overview ("You got 12 messages this week; here are the 4 that matter."), then one short bullet per summarized message with sender + subject + 1-sentence takeaway. Mention in a closing sentence that you skipped N promotional / automated messages if there were any.
- The accountId and messageId fields in listings are opaque identifiers — pass them back verbatim to the follow-up tools, do not modify or invent them.
- CRITICAL CALL FORMAT: call email_summarize_message the same way you call any other tool — emit a proper tool_calls JSON (same format you used for email_list_recent). Do NOT describe the call in prose, do NOT emit it as a code block, do NOT paraphrase the arguments. If your first attempt didn't execute, try the exact same format that worked for email_list_recent.`
		: '';

	return {
		role: 'system',
		content: `You are Haruspex, a helpful, private AI assistant running entirely on the user's computer. Nothing the user says ever leaves their device.

Today's date is ${today}. Your training data has a cutoff and is OUTDATED. Many new products, technologies, and events exist that you have ZERO knowledge of. You MUST NOT rely on your training data for anything involving specific products, hardware, software versions, current events, or recommendations.

MANDATORY SEARCH RULES:
- You MUST use web_search for ANY question about: products, hardware, software, recommendations, comparisons, reviews, current events, news, releases, pricing, or availability.
- You MUST search BEFORE answering these types of questions. Do NOT attempt to answer from memory first.
- NEVER substitute a different product or version for what the user asked about. If the user asks about something specific, search for EXACTLY what they asked about using their exact terms.
- NEVER tell the user something doesn't exist. If you don't recognize it, that means your training is outdated — search for it.
- Trust what the user tells you over your own training data. The user knows what year it is and what products exist.

WHEN NOT TO SEARCH:
- Greetings, creative writing, coding help, math, general explanations, or casual conversation.
- Information about yourself (you are Haruspex, a local AI assistant).

SEARCH BEHAVIOR:
- When searching, ONLY call the tool. Do NOT write any answer before receiving results.
- Use the user's exact terminology in your search query.
- Use fetch_url on 2-4 of the most relevant results to read the full content before answering.
- Only cite sources you actually fetched and read. Do not cite URLs you only saw in search snippets.
- For product reviews, comparisons, or "best of" questions: include community sources like Reddit alongside review sites. Many review sites are paid advertising — Reddit has real user opinions worth including.${fsSection}${emailSection}

Be concise, accurate, and helpful. When in doubt, search.

${getResponseFormatPrompt()}`
	};
}

export interface Conversation {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
	/**
	 * Optional working directory for filesystem operations. When set, the
	 * agent loop exposes filesystem tools to the model and all file operations
	 * are sandboxed to this directory. Not persisted to the database — resets
	 * when the app restarts. User picks it fresh per conversation.
	 */
	workingDir: string | null;
	/**
	 * Last known token usage for this conversation, saved so the context
	 * indicator can be restored when switching tabs. Not persisted to the
	 * database — reconstructed on the next generation.
	 */
	contextUsage: { promptTokens: number; completionTokens: number } | null;
}

interface DbMessage {
	role: string;
	content: string;
	tool_calls: string | null;
	tool_call_id: string | null;
}

interface DbConversation {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	messages: DbMessage[];
}

interface DbConversationSummary {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
}

let conversations = $state<Conversation[]>([]);
let activeConversationId = $state<string | null>(null);
let isGenerating = $state(false);
let isCompacting = $state(false);
let streamingContent = $state('');
let errorMessage = $state<string | null>(null);
let searchSteps = $state<SearchStep[]>([]);
let sourceUrls = $state<string[]>([]);
let exhaustiveResearch = $state(false);
let dbAvailable = false;

let abortController: AbortController | null = null;

function generateId(): string {
	return crypto.randomUUID();
}

function generateTitle(content: string): string {
	return content.slice(0, 50).replace(/\n/g, ' ').trim() || 'New chat';
}

// Database persistence helpers

// Marker prefix for multimodal content arrays stored in the DB.
// When a message's content is a parts array (e.g., text + images), we
// serialize it as JSON with this prefix so we can detect and rehydrate
// it on load. Plain string content is stored as-is.
const MULTIMODAL_PREFIX = '\x00MM\x00';

function serializeContent(content: ChatMessage['content']): string {
	if (typeof content === 'string') return content;
	return MULTIMODAL_PREFIX + JSON.stringify(content);
}

function deserializeContent(raw: string): ChatMessage['content'] {
	if (raw.startsWith(MULTIMODAL_PREFIX)) {
		try {
			return JSON.parse(raw.slice(MULTIMODAL_PREFIX.length));
		} catch {
			return raw;
		}
	}
	return raw;
}

async function dbSaveMessage(conversationId: string, msg: ChatMessage): Promise<void> {
	if (!dbAvailable) return;
	try {
		await invoke('db_save_message', {
			conversationId,
			role: msg.role,
			content: serializeContent(msg.content),
			toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
			toolCallId: msg.tool_call_id || null
		});
	} catch {
		// DB write failure is non-fatal
	}
}

async function dbCreateConversation(id: string, title: string): Promise<void> {
	if (!dbAvailable) return;
	try {
		await invoke('db_create_conversation', { id, title });
	} catch {
		// non-fatal
	}
}

function dbMessageToChatMessage(msg: DbMessage): ChatMessage {
	const chatMsg: ChatMessage = {
		role: msg.role as ChatMessage['role'],
		content: deserializeContent(msg.content)
	};
	if (msg.tool_calls) {
		try {
			chatMsg.tool_calls = JSON.parse(msg.tool_calls);
		} catch {
			// ignore
		}
	}
	if (msg.tool_call_id) {
		chatMsg.tool_call_id = msg.tool_call_id;
	}
	return chatMsg;
}

// Public API

export async function initChatStore(): Promise<void> {
	try {
		const summaries = await invoke<DbConversationSummary[]>('db_list_conversations');
		dbAvailable = true;

		const defaultDir = getSettings().defaultWorkingDir || null;
		conversations = summaries.map((s) => ({
			id: s.id,
			title: s.title,
			messages: [], // loaded lazily
			createdAt: s.created_at,
			updatedAt: s.updated_at,
			workingDir: defaultDir,
			contextUsage: null
		}));

		if (conversations.length > 0) {
			activeConversationId = conversations[0].id;
			await loadConversationMessages(conversations[0].id);
		}
	} catch {
		dbAvailable = false;
	}
}

async function loadConversationMessages(id: string): Promise<void> {
	if (!dbAvailable) return;
	const conv = conversations.find((c) => c.id === id);
	if (!conv || conv.messages.length > 0) return; // already loaded

	try {
		const full = await invoke<DbConversation>('db_get_conversation', { id });
		conv.messages = full.messages.map(dbMessageToChatMessage);
	} catch {
		// non-fatal
	}
}

export function getConversations(): Conversation[] {
	return conversations;
}

export function getActiveConversationId(): string | null {
	return activeConversationId;
}

export function getActiveConversation(): Conversation | undefined {
	return conversations.find((c) => c.id === activeConversationId);
}

/** Get the working directory for the active conversation, or null if none set. */
export function getWorkingDir(): string | null {
	return getActiveConversation()?.workingDir ?? null;
}

/** Set the working directory for the active conversation. Creates a new conversation if needed. */
export function setWorkingDir(path: string | null): void {
	if (!activeConversationId) {
		createConversation();
	}
	const conv = getActiveConversation();
	if (conv) {
		conv.workingDir = path;
	}
}

export function getIsGenerating(): boolean {
	return isGenerating;
}

export function getStreamingContent(): string {
	return streamingContent;
}

export function getErrorMessage(): string | null {
	return errorMessage;
}

export function getSearchSteps(): SearchStep[] {
	return searchSteps;
}

export function getSourceUrls(): string[] {
	return sourceUrls;
}

export function getIsCompacting(): boolean {
	return isCompacting;
}

export function getExhaustiveResearch(): boolean {
	return exhaustiveResearch;
}

export function setExhaustiveResearch(value: boolean): void {
	exhaustiveResearch = value;
}

async function compactIfNeeded(): Promise<void> {
	const usage = getContextUsage();
	if (!shouldCompact(usage.promptTokens, usage.contextSize)) return;

	const conversation = getActiveConversation();
	if (!conversation || conversation.messages.length < 10) return;

	isCompacting = true;
	try {
		const { summary, removedCount } = await compactConversation(conversation.messages);
		if (!summary || removedCount === 0) return;

		// Build new messages: summary + remaining messages
		const remaining = conversation.messages.filter(
			(m) => m.role === 'user' || m.role === 'assistant'
		);
		const kept = remaining.slice(remaining.length - 8); // last 4 turns
		const summaryMsg: ChatMessage = {
			role: 'system',
			content: `[Earlier conversation summary]\n${summary}`
		};
		const newMessages: ChatMessage[] = [summaryMsg, ...kept];

		conversation.messages = newMessages;
		conversation.contextUsage = null;
		resetContextUsage();

		// Persist to DB
		if (dbAvailable) {
			try {
				await invoke('db_replace_messages', {
					conversationId: conversation.id,
					messages: newMessages.map((m) => ({
						role: m.role,
						content: serializeContent(m.content),
						tool_calls: m.tool_calls ? JSON.stringify(m.tool_calls) : null,
						tool_call_id: m.tool_call_id || null
					}))
				});
			} catch {
				// non-fatal
			}
		}
	} finally {
		isCompacting = false;
	}
}

export function createConversation(): string {
	const id = generateId();
	const now = Date.now();
	conversations.unshift({
		id,
		title: 'New chat',
		messages: [],
		createdAt: now,
		updatedAt: now,
		workingDir: getSettings().defaultWorkingDir || null,
		contextUsage: null
	});
	activeConversationId = id;
	errorMessage = null;
	resetContextUsage();
	dbCreateConversation(id, 'New chat');
	return id;
}

function restoreContextUsageFor(id: string | null): void {
	const conv = conversations.find((c) => c.id === id);
	if (conv?.contextUsage) {
		setContextUsage(conv.contextUsage.promptTokens, conv.contextUsage.completionTokens);
	} else {
		resetContextUsage();
	}
}

export async function setActiveConversation(id: string): Promise<void> {
	if (conversations.some((c) => c.id === id)) {
		activeConversationId = id;
		errorMessage = null;
		restoreContextUsageFor(id);
		await loadConversationMessages(id);
	}
}

export async function deleteConversation(id: string): Promise<void> {
	const wasActive = activeConversationId === id;
	conversations = conversations.filter((c) => c.id !== id);
	if (wasActive) {
		activeConversationId = conversations.length > 0 ? conversations[0].id : null;
		restoreContextUsageFor(activeConversationId);
	}
	if (dbAvailable) {
		try {
			await invoke('db_delete_conversation', { id });
		} catch {
			// non-fatal
		}
	}
}

export async function renameConversation(id: string, title: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (conv) {
		conv.title = title;
		if (dbAvailable) {
			try {
				await invoke('db_rename_conversation', { id, title });
			} catch {
				// non-fatal
			}
		}
	}
}

export async function clearAllConversations(): Promise<void> {
	if (isGenerating) cancelGeneration();
	conversations = [];
	activeConversationId = null;
	errorMessage = null;
	if (dbAvailable) {
		try {
			await invoke('db_clear_all_conversations');
		} catch {
			// non-fatal
		}
	}
}

export function cancelGeneration(): void {
	if (abortController) {
		abortController.abort();
		abortController = null;
	}
	isGenerating = false;
}

function extractUrlsFromSteps(steps: SearchStep[]): string[] {
	const urls: string[] = [];
	for (const step of steps) {
		if (step.toolName === 'web_search' && step.result) {
			try {
				const results = JSON.parse(step.result);
				if (Array.isArray(results)) {
					for (const r of results) {
						if (r.url) urls.push(r.url);
					}
				}
			} catch {
				// ignore
			}
		} else if (step.toolName === 'fetch_url' && step.query) {
			urls.push(step.query);
		} else if (step.toolName === 'research_url' && step.query) {
			// research_url query is "URL — focus"; strip the focus suffix
			const dash = step.query.indexOf(' — ');
			urls.push(dash >= 0 ? step.query.slice(0, dash) : step.query);
		}
	}
	return [...new Set(urls)];
}

export async function sendMessage(content: string): Promise<void> {
	if (!content.trim() || isGenerating || isCompacting) return;

	if (!activeConversationId) {
		createConversation();
	}

	const conversation = getActiveConversation();
	if (!conversation) return;

	// Compact if context is getting full
	await compactIfNeeded();

	if (conversation.messages.length === 0) {
		const title = generateTitle(content);
		conversation.title = title;
		if (dbAvailable) {
			invoke('db_rename_conversation', { id: conversation.id, title }).catch(() => {});
		}
	}

	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();
	dbSaveMessage(conversation.id, userMessage);

	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	searchSteps = [];
	sourceUrls = [];
	abortController = new AbortController();

	try {
		const currentWorkingDir = conversation.workingDir;

		// Does this turn look like a "please create a file" request? The
		// agent loop uses this to detect the "I wrote the PDF" hallucination
		// and retry when the model claims a file write without actually
		// calling fs_write_*. Only meaningful when a working directory is set.
		const expectsFileOutput = !!currentWorkingDir && looksLikeFileOutputRequest(content);

		// Strip tool-related messages from previous turns to keep context clean.
		// The agent loop adds its own tool messages for the current turn.
		const historyMessages = conversation.messages.filter((m) => m.role !== 'tool' && !m.tool_calls);
		const messagesForApi: ChatMessage[] = [
			buildSystemPrompt(currentWorkingDir),
			...historyMessages
		];

		// Augment the last user message with search hints based on context.
		const lastMsg = messagesForApi[messagesForApi.length - 1];
		if (lastMsg?.role === 'user') {
			const hints: string[] = [];
			const lastText = messageText(lastMsg.content);

			// For product review/recommendation queries, hint to search Reddit.
			// Local models ignore system prompt guidance but reliably follow user message text.
			if (looksLikeReviewQuery(lastText)) {
				hints.push('Include Reddit as a source.');
			}

			// File-output reminder: when the user explicitly asked for a PDF,
			// docx, xlsx, etc., nudge the model to call the file-writing tool
			// during this turn instead of dumping the content as a chat reply
			// and waiting for a follow-up. Only fires when a working directory
			// is set (otherwise the write tools don't exist in the tool list).
			if (currentWorkingDir && looksLikeFileOutputRequest(lastText)) {
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

			// Exhaustive research mode: instruct the model to be thorough AND
			// to use the focused research_url tool for each source instead of
			// raw fetch_url. The whole point of deep research is fanning out
			// across many pages, which only works if each page is compressed
			// to relevant findings before it lands in the main context.
			if (exhaustiveResearch) {
				hints.push(
					'Research this thoroughly. Perform multiple searches from different angles. ' +
						'Read at least 4-6 sources before answering. Include diverse viewpoints. ' +
						'For every source you read, use research_url (not fetch_url) and pass a ' +
						'specific focus describing what you are looking for on that page — for ' +
						'example "pricing tiers and free plan limits", "criticisms or downsides", ' +
						'or "verbatim claims about deployment latency". Each call processes one URL.'
				);
			}

			if (hints.length > 0) {
				// Append the hint to the text portion of the message. If the message
				// is a plain string, concatenate. If it's a content array, append
				// to the last text part (or add a new one).
				const suffix = '\n\n(' + hints.join(' ') + ')';
				if (typeof lastMsg.content === 'string') {
					messagesForApi[messagesForApi.length - 1] = {
						...lastMsg,
						content: lastMsg.content + suffix
					};
				} else {
					const parts = [...lastMsg.content];
					const lastTextIdx = parts.findIndex((p) => p.type === 'text');
					if (lastTextIdx >= 0) {
						const textPart = parts[lastTextIdx] as { type: 'text'; text: string };
						parts[lastTextIdx] = { type: 'text', text: textPart.text + suffix };
					} else {
						parts.push({ type: 'text', text: suffix.trim() });
					}
					messagesForApi[messagesForApi.length - 1] = {
						...lastMsg,
						content: parts
					};
				}
			}
		}

		// Use the active context size — in remote mode this reads from
		// the probed/manual `remoteContextSize`, in local mode it falls
		// back to the standard `contextSize` setting. Compaction and the
		// context-usage indicator both need the real ceiling of the
		// currently-active backend, not the local-sidecar setting.
		const activeCtxSize = getActiveContextSize();

		// Vision is assumed available in local mode (the default Qwen
		// 3.5 build is multimodal) and probe-or-override-driven in
		// remote mode. When false, the agent loop filters vision-
		// dependent fs_* tools out of the tool list so the model can't
		// attempt image loads against a text-only backend.
		const backend = getSettings().inferenceBackend;
		const visionSupported =
			backend.mode === 'remote' ? backend.remoteVisionSupported !== false : true;

		await runAgentLoop({
			messages: messagesForApi,
			workingDir: currentWorkingDir,
			maxIterations: exhaustiveResearch ? 25 : 10,
			contextSize: activeCtxSize,
			deepResearch: exhaustiveResearch,
			expectsFileOutput,
			visionSupported,
			signal: abortController.signal,
			onUsageUpdate: (u: Usage) => {
				updateContextUsage(u, activeCtxSize);
				conversation.contextUsage = {
					promptTokens: u.prompt_tokens,
					completionTokens: u.completion_tokens
				};
			},
			onToolStart: (call) => {
				// Extract a human-readable label for each tool based on its args
				let query = '';
				switch (call.name) {
					case 'web_search':
					case 'image_search':
						query = (call.arguments.query as string) || '';
						break;
					case 'fetch_url':
					case 'fetch_url_images':
						query = (call.arguments.url as string) || '';
						break;
					case 'research_url': {
						const url = (call.arguments.url as string) || '';
						const focus = (call.arguments.focus as string) || '';
						query = focus ? `${url} — ${focus}` : url;
						break;
					}
					case 'fs_list_dir':
						query = (call.arguments.path as string) || '.';
						break;
					case 'fs_read_text':
					case 'fs_read_pdf':
					case 'fs_read_pdf_pages':
					case 'fs_read_docx':
					case 'fs_read_image':
					case 'fs_edit_text':
						query = (call.arguments.path as string) || '';
						break;
					case 'fs_read_xlsx': {
						const path = (call.arguments.path as string) || '';
						const sheet = call.arguments.sheet as string | undefined;
						query = sheet ? `${path} (${sheet})` : path;
						break;
					}
					case 'fs_write_text':
					case 'fs_write_docx':
					case 'fs_write_pdf':
					case 'fs_write_odt':
						query = (call.arguments.path as string) || '';
						break;
					case 'fs_write_xlsx':
					case 'fs_write_ods':
					case 'fs_write_pptx':
					case 'fs_write_odp':
						query = (call.arguments.path as string) || '';
						break;
					case 'fs_download_url': {
						const path = (call.arguments.path as string) || '';
						const url = (call.arguments.url as string) || '';
						query = path ? `${path} (${url})` : url;
						break;
					}
					default:
						query = JSON.stringify(call.arguments).slice(0, 60);
				}
				searchSteps = [
					...searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query,
						status: 'running'
					}
				];
			},
			onToolEnd: (call, result, thumbDataUrl) => {
				searchSteps = searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result, thumbDataUrl } : s
				);
			},
			onStreamChunk: (chunk) => {
				if (chunk.delta.reasoning_content) {
					// Wrap reasoning in think tags for the markdown renderer
					if (!streamingContent.includes('<think>')) {
						streamingContent += '<think>';
					}
					streamingContent += chunk.delta.reasoning_content;
				}
				if (chunk.delta.content) {
					// Close think block if one was open
					if (streamingContent.includes('<think>') && !streamingContent.includes('</think>')) {
						streamingContent += '</think>\n\n';
					}
					streamingContent += chunk.delta.content;
				}
			},
			onComplete: () => {
				// Strip any <tool_call> artifacts before committing. Qwen 9B
				// sometimes emits tool_call XML as chat content when it
				// degrades after long tool chains; if we save that to the DB
				// the next turn's history gets poisoned and the model keeps
				// emitting more of the same. Render-time sanitization is a
				// safety net; this is the authoritative cleanup.
				const finalContent = stripToolCallArtifacts(streamingContent).trim();
				// Shared commit helper — used for both the normal path and
				// the synthesized-fallback path so deep-research auto-
				// disable and DB persistence stay in one place.
				const commit = (content: string) => {
					const assistantMsg: ChatMessage = {
						role: 'assistant',
						content
					};
					conversation.messages.push(assistantMsg);
					dbSaveMessage(conversation.id, assistantMsg);
					// Auto-disable deep research after a successful turn so
					// follow-up messages don't accidentally re-run expensive
					// multi-search research just because the toggle was left
					// on. The user can re-enable it per turn when they want
					// another deep research pass.
					if (exhaustiveResearch) {
						exhaustiveResearch = false;
					}
				};

				if (finalContent) {
					commit(finalContent);
				} else {
					// Empty final content. Before slapping up a generic
					// "empty response" error, check what the turn actually
					// accomplished and craft a message that reflects what
					// the model was doing so the user gets a useful nudge
					// instead of a scary dead end.
					const successfulWrite = searchSteps.find(
						(s) =>
							s.toolName.startsWith('fs_write_') &&
							s.status === 'done' &&
							!(s.result || '').includes('"error"')
					);
					const doneSteps = searchSteps.filter((s) => s.status === 'done');
					const anyToolCompleted = doneSteps.length > 0;
					const emailListed = doneSteps.some((s) => s.toolName === 'email_list_recent');
					const emailSummarized = doneSteps.some((s) => s.toolName === 'email_summarize_message');
					const imageSearched = doneSteps.some(
						(s) => s.toolName === 'image_search' || s.toolName === 'fetch_url_images'
					);
					const webResearched = doneSteps.some(
						(s) =>
							s.toolName === 'web_search' ||
							s.toolName === 'fetch_url' ||
							s.toolName === 'research_url'
					);

					// Diagnostic: log the pre-strip streaming content so we can
					// see what the model actually emitted when the final synthesis
					// came back empty. Lives in the browser console (dev mode) and
					// the app log tab (production) via the console-capture shim.
					if (streamingContent) {
						console.warn(
							'[empty-final-content] streamingContent length=',
							streamingContent.length,
							'first 500 chars:',
							streamingContent.slice(0, 500)
						);
					}

					if (successfulWrite) {
						commit(`Done. File written: ${successfulWrite.query}`);
					} else if (emailListed && !emailSummarized) {
						// Email listing ran but the model never got a
						// summarize_message call to execute. This is the most
						// common email failure mode: model misformats the
						// follow-up tool call, retry nudges don't stick, loop
						// exits without final synthesis.
						errorMessage =
							'Fetched your email listing but could not produce a summary. ' +
							'The model struggled to emit a valid follow-up tool call. ' +
							'Try a narrower request like "summarize my email from the last 4 hours" ' +
							'or "summarize the 3 most recent emails from alice@example.com" — ' +
							'giving the model a smaller, more focused set is more reliable ' +
							'than asking it to digest a week of messages at once.';
					} else if (emailListed) {
						errorMessage =
							'Email digest run completed but the final summary did not arrive. ' +
							'Try a more focused request ("summarize the 3 most recent", "what did ' +
							'alice send this week?") so the model has less to synthesize.';
					} else if (imageSearched) {
						errorMessage =
							'Research completed but the model did not produce a final answer ' +
							'or file. The image-discovery step may have stalled — try a ' +
							'follow-up like "write the presentation with what you have so far, ' +
							'no images" to force the model to finish.';
					} else if (webResearched) {
						errorMessage =
							'Web research completed but the final answer did not arrive. ' +
							'This usually means the model got stuck after many tool calls. ' +
							'Try a more focused question, disable deep research if enabled, ' +
							'or break the question into smaller pieces.';
					} else if (anyToolCompleted) {
						errorMessage =
							'Tools ran but the model did not produce a final answer. ' +
							'Try rephrasing or a more focused question.';
					} else {
						errorMessage = 'Model returned an empty response. Try rephrasing.';
					}
				}
				sourceUrls = extractUrlsFromSteps(searchSteps);
			},
			onError: (error) => {
				if (error instanceof ApiError) {
					errorMessage = error.message;
				} else {
					errorMessage = 'An unexpected error occurred.';
				}
			}
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			if (streamingContent) {
				const partialMsg: ChatMessage = {
					role: 'assistant',
					content: streamingContent
				};
				conversation.messages.push(partialMsg);
				dbSaveMessage(conversation.id, partialMsg);
			}
		} else if (e instanceof ApiError) {
			errorMessage = e.message;
		} else {
			errorMessage = 'An unexpected error occurred.';
		}
	} finally {
		isGenerating = false;
		streamingContent = '';
		abortController = null;
		conversation.updatedAt = Date.now();
	}
}
