import { type ChatMessage, type Usage, ApiError, messageText } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { shouldCompact, compactConversation } from '$lib/agent/compaction';
import {
	getActiveContextSize,
	getResponseFormatPrompt,
	getSettings,
	hasEnabledEmailAccount
} from '$lib/stores/settings';
import { processCitations, renderMarkdown, stripToolCallArtifacts } from '$lib/markdown';
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
	// During generation, derive the chip row from the citations actually
	// present in the streaming answer so chip numbering and inline [N]
	// numbering stay in lockstep as the model writes. Between turns we
	// fall back to whatever was committed at the end of the last turn.
	if (isGenerating && streamingContent) {
		const fetched = extractUrlsFromSteps(searchSteps);
		const { citedUrls } = processCitations(streamingContent, fetched);
		return citedUrls;
	}
	return sourceUrls;
}

/**
 * Render the currently-streaming assistant message with citation
 * renumbering applied. Extracted from the page component so the page
 * doesn't need to know about processCitations or the shape of
 * searchSteps — it just asks the store for HTML to drop into the DOM.
 */
export function renderStreamingHtml(text: string): string {
	if (!text) return '';
	const fetched = extractUrlsFromSteps(searchSteps);
	const { content } = processCitations(text, fetched);
	return renderMarkdown(content);
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
	// Only include URLs the model actually fetched and read. Bare web_search
	// result URLs are excluded because the model can't cite a page it didn't
	// open. Keeping this list narrow also keeps the inline [N] citations
	// numbered the same way as the source chips at the bottom of the reply.
	const urls: string[] = [];
	for (const step of steps) {
		if (step.toolName === 'fetch_url' && step.query) {
			if (step.status === 'done' && isFetchFailure(step.result)) continue;
			urls.push(step.query);
		} else if (step.toolName === 'research_url' && step.query) {
			if (step.status === 'done' && isFetchFailure(step.result)) continue;
			// research_url query is "URL — focus"; strip the focus suffix
			const dash = step.query.indexOf(' — ');
			urls.push(dash >= 0 ? step.query.slice(0, dash) : step.query);
		}
	}
	return [...new Set(urls)];
}

function isFetchFailure(result: string | undefined): boolean {
	if (!result) return false;
	return (
		result.startsWith('Failed to fetch') ||
		result.startsWith('Research sub-agent failed') ||
		result.startsWith('Paywalled:')
	);
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
				//
				// Then renumber inline citations so the saved content has
				// [1], [2], ... anchor text that matches the chip row. The
				// model emits each citation as a real markdown link to the
				// URL it fetched, and we renumber based on appearance order.
				const fetched = extractUrlsFromSteps(searchSteps);
				const processed = processCitations(
					stripToolCallArtifacts(streamingContent).trim(),
					fetched
				);
				const finalContent = processed.content;
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
				// Final chip row = exactly the URLs the model cited inline,
				// so clicking [3] in the answer opens the third chip. If the
				// model cited nothing (e.g., pure synthesis / no web lookup)
				// the chip row stays empty.
				sourceUrls = processed.citedUrls;
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
				// Bake citations into the partial message on abort too so
				// the saved history isn't left with bare markdown links and
				// an inconsistent chip row.
				const fetched = extractUrlsFromSteps(searchSteps);
				const { content, citedUrls } = processCitations(streamingContent, fetched);
				const partialMsg: ChatMessage = {
					role: 'assistant',
					content
				};
				conversation.messages.push(partialMsg);
				dbSaveMessage(conversation.id, partialMsg);
				sourceUrls = citedUrls;
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
