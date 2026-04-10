import { type ChatMessage, type Usage, ApiError, messageText } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { shouldCompact, compactConversation } from '$lib/agent/compaction';
import { getResponseFormatPrompt, getSettings } from '$lib/stores/settings';
import { getContextUsage, updateContextUsage, resetContextUsage } from '$lib/stores/context.svelte';
import { invoke } from '@tauri-apps/api/core';

const REVIEW_PATTERNS =
	/\b(best|top\s+\d|recommend|review|comparison|compare|vs\.?|versus|worth|which\s+(?:one|should)|budget|premium|upgrade)\b/i;

function looksLikeReviewQuery(content: string): boolean {
	return REVIEW_PATTERNS.test(content);
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
- Use fs_write_pdf to create a PDF from markdown-style content (# for headings). Use for printable reports; use fs_write_docx when the user wants an editable doc.
- Use fs_write_xlsx to create an Excel spreadsheet from structured sheet data.
- Use fs_edit_text for small targeted changes — it replaces exactly one occurrence of old_str with new_str.
- You cannot delete or move files. If the user wants to remove a file, tell them to do it manually.
- When creating bash or shell scripts, include a shebang line (#!/bin/bash or #!/usr/bin/env bash) and remind the user they must chmod +x and run the script themselves — you cannot execute scripts.`
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
- For product reviews, comparisons, or "best of" questions: include community sources like Reddit alongside review sites. Many review sites are paid advertising — Reddit has real user opinions worth including.${fsSection}

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

		conversations = summaries.map((s) => ({
			id: s.id,
			title: s.title,
			messages: [], // loaded lazily
			createdAt: s.created_at,
			updatedAt: s.updated_at,
			workingDir: null
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
		workingDir: null
	});
	activeConversationId = id;
	errorMessage = null;
	resetContextUsage();
	dbCreateConversation(id, 'New chat');
	return id;
}

export async function setActiveConversation(id: string): Promise<void> {
	if (conversations.some((c) => c.id === id)) {
		activeConversationId = id;
		errorMessage = null;
		resetContextUsage();
		await loadConversationMessages(id);
	}
}

export async function deleteConversation(id: string): Promise<void> {
	conversations = conversations.filter((c) => c.id !== id);
	if (activeConversationId === id) {
		activeConversationId = conversations.length > 0 ? conversations[0].id : null;
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

		await runAgentLoop({
			messages: messagesForApi,
			workingDir: currentWorkingDir,
			maxIterations: exhaustiveResearch ? 25 : 10,
			contextSize: getSettings().contextSize,
			deepResearch: exhaustiveResearch,
			signal: abortController.signal,
			onUsageUpdate: (u: Usage) => {
				updateContextUsage(u, getSettings().contextSize);
			},
			onToolStart: (call) => {
				// Extract a human-readable label for each tool based on its args
				let query = '';
				switch (call.name) {
					case 'web_search':
						query = (call.arguments.query as string) || '';
						break;
					case 'fetch_url':
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
						query = (call.arguments.path as string) || '';
						break;
					case 'fs_write_xlsx':
						query = (call.arguments.path as string) || '';
						break;
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
			onToolEnd: (call, result) => {
				searchSteps = searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result } : s
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
				const finalContent = streamingContent;
				if (finalContent) {
					const assistantMsg: ChatMessage = {
						role: 'assistant',
						content: finalContent
					};
					conversation.messages.push(assistantMsg);
					dbSaveMessage(conversation.id, assistantMsg);
				} else {
					errorMessage = 'Model returned an empty response. Try rephrasing.';
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
