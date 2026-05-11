import { type ChatMessage, type Usage, ApiError } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { getDisplayLabel } from '$lib/agent/tools';
import { shouldCompact, compactConversation } from '$lib/agent/compaction';
import {
	buildSystemPrompt,
	looksLikeFileOutputRequest,
	injectMessageHints
} from '$lib/agent/system-prompt';
import { diagnoseEmptyResponse } from '$lib/agent/diagnostics';
import { beginTurn, logDebug } from '$lib/debug-log';
import { getActiveContextSize, getSettings } from '$lib/stores/settings';
import { processCitations, renderMarkdown, stripToolCallArtifacts } from '$lib/markdown';
import { runPython, installPackage, resetSandbox } from '$lib/sandbox/sandbox';
import {
	getContextUsage,
	updateContextUsage,
	resetContextUsage,
	setContextUsage
} from '$lib/stores/context.svelte';
import {
	initDb,
	dbSaveMessage,
	dbCreateConversation,
	dbRenameConversation,
	dbDeleteConversation,
	dbClearAll,
	dbLoadMessages,
	dbReplaceMessages,
	type DbConversationSummary
} from '$lib/stores/db';

export interface Conversation {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
	workingDir: string | null;
	contextUsage: { promptTokens: number; completionTokens: number } | null;
	/** Search steps from the last generation in this conversation. Not persisted to DB. */
	searchSteps: SearchStep[];
	/**
	 * Completed search steps from past turns, indexed by the position of the
	 * assistant message they belong to in `messages`. Lets the UI keep
	 * rendering rich artifacts (plots, tables) under the message that
	 * produced them after the live `searchSteps` is cleared at the start
	 * of the next turn. In-memory only — not persisted to DB, so plots
	 * vanish on app restart or chat reload (acceptable for v1).
	 */
	messageSteps: Record<number, SearchStep[]>;
	/** Cited source URLs from the last generation. Not persisted to DB. */
	sourceUrls: string[];
	/**
	 * True once the user has approved Python sandbox code execution for
	 * this chat (in once-per-chat mode). In-memory only — re-prompts on
	 * app restart, on chat reload from DB, and when sandbox approval
	 * mode is set to every-run.
	 */
	sandboxApproved: boolean;
	/**
	 * True while we're rebuilding the chat's Python sandbox state by
	 * replaying its prior install_package / run_python / reset_python
	 * tool calls against a fresh worker. Drives a small "Restoring
	 * Python session…" indicator in the input area.
	 */
	isRestoringSession: boolean;
	/**
	 * Set when a chat had too many prior code calls to replay (>50)
	 * and we skipped restoration. Future code runs in this chat will
	 * start with a fresh sandbox; whatever variables/imports the model
	 * had are gone.
	 */
	sessionRestoreSkipped: boolean;
	/**
	 * Tool-call + tool-result messages from the most recent completed turn.
	 * Optionally spliced back into the next turn's prompt when the
	 * `keepRecentToolResults` setting is enabled, so followup questions can
	 * reference raw research details. In-memory only — not persisted to DB.
	 */
	lastTurnTools?: ChatMessage[];
}

let conversations = $state<Conversation[]>([]);
let activeConversationId = $state<string | null>(null);
let isGenerating = $state(false);
let isCompacting = $state(false);
let streamingContent = $state('');
let errorMessage = $state<string | null>(null);
// Turn id of the agent run that produced the current error, if any. The
// chat UI uses this to render a "copy debug log for this failure" button
// that filters the debug-log ring buffer down to a single turn's worth
// of entries — much easier to share than the full interleaved buffer.
let errorTurnId = $state<number | null>(null);
let currentTurnId: number | null = null;
let exhaustiveResearch = $state(false);

let abortController: AbortController | null = null;

function generateId(): string {
	return crypto.randomUUID();
}

function generateTitle(content: string): string {
	return content.slice(0, 50).replace(/\n/g, ' ').trim() || 'New chat';
}

// Public API

export async function initChatStore(): Promise<void> {
	const db = await initDb();

	const defaultDir = getSettings().defaultWorkingDir || null;
	conversations = db.summaries.map((s: DbConversationSummary) => ({
		id: s.id,
		title: s.title,
		messages: [],
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		workingDir: defaultDir,
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		sourceUrls: [],
		sandboxApproved: false,
		isRestoringSession: false,
		sessionRestoreSkipped: false
	}));

	if (conversations.length > 0) {
		activeConversationId = conversations[0].id;
		await loadConversationMessages(conversations[0].id);
	}
}

async function loadConversationMessages(id: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (!conv || conv.messages.length > 0) return;
	conv.messages = await dbLoadMessages(id);
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

export function getWorkingDir(): string | null {
	return getActiveConversation()?.workingDir ?? null;
}

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

export function getErrorTurnId(): number | null {
	return errorTurnId;
}

export function getSearchSteps(): SearchStep[] {
	return getActiveConversation()?.searchSteps ?? [];
}

export function getSourceUrls(): string[] {
	const conv = getActiveConversation();
	if (!conv) return [];
	if (isGenerating && streamingContent) {
		const fetched = extractUrlsFromSteps(conv.searchSteps);
		const { citedUrls } = processCitations(streamingContent, fetched);
		return citedUrls;
	}
	return conv.sourceUrls;
}

export function renderStreamingHtml(text: string): string {
	if (!text) return '';
	const conv = getActiveConversation();
	const fetched = extractUrlsFromSteps(conv?.searchSteps ?? []);
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

		const remaining = conversation.messages.filter(
			(m) => m.role === 'user' || m.role === 'assistant'
		);
		const kept = remaining.slice(remaining.length - 8);
		const summaryMsg: ChatMessage = {
			role: 'system',
			content: `[Earlier conversation summary]\n${summary}`
		};
		const newMessages: ChatMessage[] = [summaryMsg, ...kept];

		conversation.messages = newMessages;
		conversation.contextUsage = null;
		// The turn `lastTurnTools` belonged to has just been summarized away;
		// keeping the raw tool messages would re-inflate the same context we
		// just compacted.
		conversation.lastTurnTools = undefined;
		resetContextUsage();

		await dbReplaceMessages(conversation.id, newMessages);
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
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		sourceUrls: [],
		sandboxApproved: false,
		isRestoringSession: false,
		sessionRestoreSkipped: false
	});
	activeConversationId = id;
	errorMessage = null;
	errorTurnId = null;
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
		errorTurnId = null;
		restoreContextUsageFor(id);
		await loadConversationMessages(id);
		// Fire-and-forget; the replay updates conv.isRestoringSession so
		// the UI can show a small indicator while it runs.
		void restoreSandboxSession(id);
	}
}

/**
 * Maximum number of prior sandbox tool calls we'll replay when restoring
 * a chat's Python session. Above this, we skip replay (the user gets a
 * fresh sandbox, plus a `sessionRestoreSkipped` flag so the chat UI can
 * surface that state). Catches the pathological case of a chat with
 * hundreds of code runs that would block the UI for 30+ seconds.
 */
const SESSION_REPLAY_CAP = 50;

interface SandboxCallToReplay {
	name: 'run_python' | 'install_package' | 'reset_python';
	args: { code?: string; package?: string };
}

function collectSandboxCalls(messages: ChatMessage[]): SandboxCallToReplay[] {
	const out: SandboxCallToReplay[] = [];
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.tool_calls) continue;
		for (const call of msg.tool_calls) {
			const name = call.function?.name;
			if (name !== 'run_python' && name !== 'install_package' && name !== 'reset_python') continue;
			let args: { code?: string; package?: string } = {};
			try {
				args = JSON.parse(call.function.arguments ?? '{}');
			} catch {
				continue;
			}
			out.push({ name, args });
		}
	}
	return out;
}

/**
 * Walk a chat's message history, find every prior install_package /
 * run_python / reset_python tool call, and replay them sequentially
 * against a fresh sandbox worker so the model picks up where it left
 * off. Per-call errors are swallowed (the chat history already records
 * what the model saw at the time; the goal is to rebuild state, not
 * surface failures). The active-chat guard aborts replay if the user
 * switches to another chat mid-flight.
 */
async function restoreSandboxSession(id: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (!conv) return;
	if (!getSettings().sandboxEnabled) return;
	const calls = collectSandboxCalls(conv.messages);
	if (calls.length === 0) return;
	if (calls.length > SESSION_REPLAY_CAP) {
		conv.sessionRestoreSkipped = true;
		logDebug('sandbox', 'session restore skipped — too many prior calls', {
			chatId: id,
			callCount: calls.length,
			cap: SESSION_REPLAY_CAP
		});
		return;
	}
	conv.isRestoringSession = true;
	conv.sessionRestoreSkipped = false;
	logDebug('sandbox', 'session restore start', { chatId: id, callCount: calls.length });
	try {
		// Reset the worker so replay starts clean. Other chats that had
		// active sandbox state lose it — by design, single-worker model.
		await resetSandbox();
		for (const call of calls) {
			if (activeConversationId !== id) {
				logDebug('sandbox', 'session restore aborted — chat switched', { fromChatId: id });
				return;
			}
			try {
				if (call.name === 'install_package' && call.args.package) {
					await installPackage(call.args.package);
				} else if (call.name === 'run_python' && call.args.code) {
					await runPython(call.args.code);
				} else if (call.name === 'reset_python') {
					await resetSandbox();
				}
			} catch (err) {
				logDebug('sandbox', `session restore: ${call.name} failed (skipping)`, {
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
		// Successful restore implies the user previously approved code in
		// this chat, so don't re-prompt on the next code call.
		conv.sandboxApproved = true;
		logDebug('sandbox', 'session restore complete', { chatId: id });
	} finally {
		conv.isRestoringSession = false;
	}
}

export async function deleteConversation(id: string): Promise<void> {
	const wasActive = activeConversationId === id;
	conversations = conversations.filter((c) => c.id !== id);
	if (wasActive) {
		activeConversationId = conversations.length > 0 ? conversations[0].id : null;
		restoreContextUsageFor(activeConversationId);
	}
	await dbDeleteConversation(id);
}

export async function renameConversation(id: string, title: string): Promise<void> {
	const conv = conversations.find((c) => c.id === id);
	if (conv) {
		conv.title = title;
		await dbRenameConversation(id, title);
	}
}

export async function clearAllConversations(): Promise<void> {
	if (isGenerating) cancelGeneration();
	conversations = [];
	activeConversationId = null;
	errorMessage = null;
	errorTurnId = null;
	await dbClearAll();
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
		if (step.toolName === 'fetch_url' && step.query) {
			if (step.status === 'done' && isFetchFailure(step.result)) continue;
			urls.push(step.query);
		} else if (step.toolName === 'research_url' && step.query) {
			if (step.status === 'done' && isFetchFailure(step.result)) continue;
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

	await compactIfNeeded();

	if (conversation.messages.length === 0) {
		const title = generateTitle(content);
		conversation.title = title;
		dbRenameConversation(conversation.id, title);
	}

	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();
	dbSaveMessage(conversation.id, userMessage);

	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	errorTurnId = null;
	currentTurnId = beginTurn();
	conversation.searchSteps = [];
	conversation.sourceUrls = [];
	abortController = new AbortController();

	try {
		const currentWorkingDir = conversation.workingDir;
		const expectsFileOutput = !!currentWorkingDir && looksLikeFileOutputRequest(content);

		const historyMessages = conversation.messages.filter((m) => m.role !== 'tool' && !m.tool_calls);
		let messagesForApi: ChatMessage[] = [buildSystemPrompt(currentWorkingDir), ...historyMessages];

		// If the user opted in, splice the previous turn's tool_calls + tool
		// messages back into the prompt so the model can reference its own
		// research on followup questions. Insertion point is just before the
		// most recent assistant prose (the prior turn's final answer), so the
		// canonical sequence becomes:
		//   ...older history, user_{N-1}, [tool_calls + results], asst_{N-1}, user_N
		// preserving the OpenAI tool-call/result pairing.
		const keepRecentTools = getSettings().keepRecentToolResults;
		if (keepRecentTools && conversation.lastTurnTools && conversation.lastTurnTools.length > 0) {
			// Just-pushed user is at the end; the prior assistant prose sits at
			// length - 2. If the shape doesn't match (e.g. very first turn),
			// skip the splice rather than risk a malformed prompt.
			const insertIdx = messagesForApi.length - 2;
			if (insertIdx >= 0 && messagesForApi[insertIdx].role === 'assistant') {
				messagesForApi = [
					...messagesForApi.slice(0, insertIdx),
					...conversation.lastTurnTools,
					...messagesForApi.slice(insertIdx)
				];
			}
		}

		messagesForApi = injectMessageHints(messagesForApi, {
			workingDir: currentWorkingDir,
			exhaustiveResearch
		});

		const baseMessageCount = messagesForApi.length;

		const activeCtxSize = getActiveContextSize();

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
				conversation.searchSteps = [
					...conversation.searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query: getDisplayLabel(call.name, call.arguments),
						status: 'running',
						args: call.arguments
					}
				];
			},
			onToolEnd: (call, result, thumbDataUrl, artifacts) => {
				conversation.searchSteps = conversation.searchSteps.map((s) =>
					s.id === call.id ? { ...s, status: 'done' as const, result, thumbDataUrl, artifacts } : s
				);
			},
			onStreamChunk: (chunk) => {
				if (chunk.delta.reasoning_content) {
					if (!streamingContent.includes('<think>')) {
						streamingContent += '<think>';
					}
					streamingContent += chunk.delta.reasoning_content;
				}
				if (chunk.delta.content) {
					if (streamingContent.includes('<think>') && !streamingContent.includes('</think>')) {
						streamingContent += '</think>\n\n';
					}
					streamingContent += chunk.delta.content;
				}
			},
			onComplete: () => {
				const fetched = extractUrlsFromSteps(conversation.searchSteps);
				const processed = processCitations(
					stripToolCallArtifacts(streamingContent).trim(),
					fetched
				);
				const finalContent = processed.content;

				const commit = (text: string) => {
					const assistantMsg: ChatMessage = { role: 'assistant', content: text };
					// Snapshot the live search steps onto the assistant message's
					// position so the UI can keep rendering plots/tables under
					// this message after the live `searchSteps` is cleared.
					const stepsForThisTurn = conversation.searchSteps.filter(
						(s) => s.status === 'done' && (s.result || s.thumbDataUrl || s.artifacts?.length)
					);
					if (stepsForThisTurn.length > 0) {
						conversation.messageSteps[conversation.messages.length] = stepsForThisTurn;
					}
					conversation.messages.push(assistantMsg);
					dbSaveMessage(conversation.id, assistantMsg);
					// Clear the live indicator now that the steps live on the
					// committed message. Without this both render simultaneously
					// (live + persisted) and the user sees doubled artifacts.
					conversation.searchSteps = [];
					if (exhaustiveResearch) {
						exhaustiveResearch = false;
					}
				};

				if (finalContent) {
					logDebug('chat', 'onComplete commit', {
						rawStreamingLen: streamingContent.length,
						finalContentLen: finalContent.length,
						citedUrls: processed.citedUrls
					});
					commit(finalContent);
				} else {
					const diagnosis = diagnoseEmptyResponse(conversation.searchSteps, streamingContent);
					logDebug('chat', `onComplete empty → diagnosis ${diagnosis.type}`, {
						rawStreamingLen: streamingContent.length,
						rawStreamingPreview: streamingContent.slice(0, 2000),
						diagnosis
					});
					if (diagnosis.type === 'commit') {
						commit(diagnosis.content);
					} else {
						errorMessage = diagnosis.message;
						errorTurnId = currentTurnId;
					}
				}
				conversation.sourceUrls = processed.citedUrls;
			},
			onError: (error) => {
				if (error instanceof ApiError) {
					errorMessage = error.message;
				} else {
					errorMessage = 'An unexpected error occurred.';
				}
				errorTurnId = currentTurnId;
			}
		});

		// Capture any tool-call / tool-result messages the loop appended so
		// the next turn can optionally splice them back in. We slice from
		// the pre-loop length and filter to just the messages that need to
		// stay paired (assistant tool_calls + their tool results) — recovery
		// nudges like "Continue." aren't useful on the next turn.
		if (keepRecentTools) {
			const appended = messagesForApi.slice(baseMessageCount);
			const toolPairs = appended.filter(
				(m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)
			);
			conversation.lastTurnTools = toolPairs.length > 0 ? toolPairs : undefined;
		} else {
			conversation.lastTurnTools = undefined;
		}
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			if (streamingContent) {
				const fetched = extractUrlsFromSteps(conversation.searchSteps);
				const { content, citedUrls } = processCitations(streamingContent, fetched);
				const partialMsg: ChatMessage = { role: 'assistant', content };
				const stepsForThisTurn = conversation.searchSteps.filter(
					(s) => s.status === 'done' && (s.result || s.thumbDataUrl || s.artifacts?.length)
				);
				if (stepsForThisTurn.length > 0) {
					conversation.messageSteps[conversation.messages.length] = stepsForThisTurn;
				}
				conversation.messages.push(partialMsg);
				dbSaveMessage(conversation.id, partialMsg);
				conversation.searchSteps = [];
				conversation.sourceUrls = citedUrls;
			}
		} else if (e instanceof ApiError) {
			errorMessage = e.message;
			errorTurnId = currentTurnId;
		} else {
			errorMessage = 'An unexpected error occurred.';
			errorTurnId = currentTurnId;
		}
	} finally {
		isGenerating = false;
		streamingContent = '';
		abortController = null;
		conversation.updatedAt = Date.now();
	}
}
