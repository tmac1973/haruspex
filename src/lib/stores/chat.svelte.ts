import { type ChatMessage, type Usage, ApiError } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { withInferenceSlot } from '$lib/agent/inferenceQueue.svelte';
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
	/**
	 * Per-assistant-message generation stats (tok/s, completion tokens,
	 * wall-clock duration of the visible stream), keyed by the position
	 * of the assistant message in `messages`. In-memory only — vanishes
	 * on app restart or chat reload.
	 */
	messageStats: Record<number, MessageStats>;
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

export interface MessageStats {
	tokensPerSecond: number;
	completionTokens: number;
	durationMs: number;
}

const WORKING_DIR_KEY = 'haruspex-working-dir';

function loadWorkingDir(): string | null {
	try {
		const raw = localStorage.getItem(WORKING_DIR_KEY);
		if (raw !== null) return raw || null;
		// One-time migration from the legacy per-settings defaultWorkingDir.
		const legacy = localStorage.getItem('haruspex-settings');
		if (legacy) {
			const parsed = JSON.parse(legacy);
			if (typeof parsed.defaultWorkingDir === 'string' && parsed.defaultWorkingDir) {
				localStorage.setItem(WORKING_DIR_KEY, parsed.defaultWorkingDir);
				return parsed.defaultWorkingDir;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

function saveWorkingDir(path: string | null): void {
	try {
		localStorage.setItem(WORKING_DIR_KEY, path ?? '');
	} catch {
		// ignore
	}
}

let conversations = $state<Conversation[]>([]);
let activeConversationId = $state<string | null>(null);
let workingDir = $state<string | null>(loadWorkingDir());
let isGenerating = $state(false);
let isWaitingForSlot = $state(false);
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

	conversations = db.summaries.map((s: DbConversationSummary) => ({
		id: s.id,
		title: s.title,
		messages: [],
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		messageStats: {},
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
	return workingDir;
}

export function setWorkingDir(path: string | null): void {
	const previous = workingDir;
	workingDir = path;
	saveWorkingDir(path);
	// Switching to a different workdir means the worker's MEMFS + the
	// manager's syncedFiles cache are pinned to the OLD workdir's
	// absolute paths. Leaving them in place leaks ghost files and means
	// Python's cwd doesn't follow the change. Respawning forces the next
	// run_python to do a fresh sync against the new workdir.
	if (previous !== path) {
		void resetSandbox();
	}
}

export function getIsGenerating(): boolean {
	return isGenerating;
}

export function getIsWaitingForSlot(): boolean {
	return isWaitingForSlot;
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
		contextUsage: null,
		searchSteps: [],
		messageSteps: {},
		messageStats: {},
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

/**
 * Bookkeeping for a single in-flight turn. Held in a stable object so
 * the runAgentLoop callback bundle can mutate it and `commitMessage`
 * can read it back when building the persisted assistant message.
 */
interface TurnStats {
	lastCallStats: { durationMs: number; completionTokens: number } | null;
}

function computeStats(stats: TurnStats): MessageStats | null {
	const s = stats.lastCallStats;
	if (!s || s.completionTokens <= 0 || s.durationMs <= 0) return null;
	return {
		tokensPerSecond: s.completionTokens / (s.durationMs / 1000),
		completionTokens: s.completionTokens,
		durationMs: s.durationMs
	};
}

/**
 * Validate the send precondition and ensure an active conversation
 * exists. Returns the conversation when sending is allowed, `null` if
 * the caller should silently no-op (empty input, already generating,
 * mid-compaction, or no conversation could be created).
 */
function ensureSendableConversation(content: string): Conversation | null {
	if (!content.trim() || isGenerating || isCompacting) return null;
	if (!activeConversationId) createConversation();
	return getActiveConversation() ?? null;
}

/**
 * Set the conversation title on the first turn, push the user message,
 * and persist it. Mutates the conversation in place.
 */
function finalizeUserTurn(conversation: Conversation, content: string): void {
	if (conversation.messages.length === 0) {
		const title = generateTitle(content);
		conversation.title = title;
		dbRenameConversation(conversation.id, title);
	}
	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();
	dbSaveMessage(conversation.id, userMessage);
}

/**
 * Reset per-turn UI state (streaming buffer, error indicators, search
 * steps, abort controller) and start a fresh turn id. Returns the new
 * abort controller's signal for convenience.
 */
function resetTurnState(conversation: Conversation): AbortSignal {
	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	errorTurnId = null;
	currentTurnId = beginTurn();
	conversation.searchSteps = [];
	conversation.sourceUrls = [];
	abortController = new AbortController();
	return abortController.signal;
}

/**
 * Assemble the message array sent to the agent loop: system prompt
 * + history (filtered to user/assistant prose) + optional spliced
 * lastTurnTools + hint injection. Returns the messages plus the
 * pre-loop length so the caller can later slice off the loop-appended
 * tool pairs for `lastTurnTools`.
 */
function buildApiPrompt(
	conversation: Conversation,
	workingDir: string | null,
	keepRecentTools: boolean
): { messages: ChatMessage[]; baseMessageCount: number } {
	const historyMessages = conversation.messages.filter((m) => m.role !== 'tool' && !m.tool_calls);
	let messagesForApi: ChatMessage[] = [buildSystemPrompt(workingDir), ...historyMessages];

	// If the user opted in, splice the previous turn's tool_calls + tool
	// messages back into the prompt so the model can reference its own
	// research on followup questions. Insertion point is just before the
	// most recent assistant prose (the prior turn's final answer), so the
	// canonical sequence becomes:
	//   ...older history, user_{N-1}, [tool_calls + results], asst_{N-1}, user_N
	// preserving the OpenAI tool-call/result pairing.
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
		workingDir,
		exhaustiveResearch
	});
	return { messages: messagesForApi, baseMessageCount: messagesForApi.length };
}

/**
 * Persist a completed assistant message to the conversation: snapshot
 * the live search steps onto the message's index, attach per-message
 * tok/s stats, push the message, save to db, and clear the live steps
 * so the UI doesn't render the steps twice (live + persisted).
 */
function commitMessage(conversation: Conversation, content: string, stats: TurnStats): void {
	const assistantMsg: ChatMessage = { role: 'assistant', content };
	const messageIndex = conversation.messages.length;
	const stepsForThisTurn = conversation.searchSteps.filter(
		(s) => s.status === 'done' && (s.result || s.thumbDataUrl || s.artifacts?.length)
	);
	if (stepsForThisTurn.length > 0) {
		conversation.messageSteps[messageIndex] = stepsForThisTurn;
	}
	const messageStats = computeStats(stats);
	if (messageStats) {
		conversation.messageStats[messageIndex] = messageStats;
	}
	conversation.messages.push(assistantMsg);
	dbSaveMessage(conversation.id, assistantMsg);
	conversation.searchSteps = [];
}

/**
 * After a successful runAgentLoop, capture any tool-call / tool-result
 * messages the loop appended so the next turn can optionally splice
 * them back in. We slice from the pre-loop length and filter to just
 * the messages that need to stay paired (assistant tool_calls + their
 * tool results) — recovery nudges like "Continue." aren't useful on
 * the next turn.
 */
function captureToolPairsForNextTurn(
	conversation: Conversation,
	messagesForApi: ChatMessage[],
	baseMessageCount: number,
	keepRecentTools: boolean
): void {
	if (keepRecentTools) {
		const appended = messagesForApi.slice(baseMessageCount);
		const toolPairs = appended.filter(
			(m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)
		);
		conversation.lastTurnTools = toolPairs.length > 0 ? toolPairs : undefined;
	} else {
		conversation.lastTurnTools = undefined;
	}
}

/**
 * Persist whatever content streamed before an AbortError, then clear
 * the live UI state. No-op if nothing streamed yet.
 */
function commitPartialOnAbort(conversation: Conversation, stats: TurnStats): void {
	if (!streamingContent) return;
	const fetched = extractUrlsFromSteps(conversation.searchSteps);
	const { content, citedUrls } = processCitations(streamingContent, fetched);
	commitMessage(conversation, content, stats);
	conversation.sourceUrls = citedUrls;
}

/**
 * Map a caught exception to the user-facing error banner. Aborts are
 * handled separately by commitPartialOnAbort and skip this path.
 */
function handleTurnError(e: unknown): void {
	if (e instanceof ApiError) {
		errorMessage = e.message;
	} else {
		errorMessage = 'An unexpected error occurred.';
	}
	errorTurnId = currentTurnId;
}

export async function sendMessage(content: string): Promise<void> {
	const conversation = ensureSendableConversation(content);
	if (!conversation) return;

	await compactIfNeeded();
	finalizeUserTurn(conversation, content);
	const signal = resetTurnState(conversation);

	// Tok/s timing: the agent loop emits per-call timing via onCallStats.
	// Latch the most recent one — it corresponds to the model call whose
	// output is being committed. Earlier tool-decision calls get
	// overwritten by the final synthesis call, which is what we want.
	const turnStats: TurnStats = { lastCallStats: null };

	try {
		const currentWorkingDir = workingDir;
		const expectsFileOutput = !!currentWorkingDir && looksLikeFileOutputRequest(content);

		const keepRecentTools = getSettings().keepRecentToolResults;
		const { messages: messagesForApi, baseMessageCount } = buildApiPrompt(
			conversation,
			currentWorkingDir,
			keepRecentTools
		);

		const activeCtxSize = getActiveContextSize();

		const backend = getSettings().inferenceBackend;
		const visionSupported =
			backend.mode === 'remote' ? backend.remoteVisionSupported !== false : true;

		isWaitingForSlot = true;
		await withInferenceSlot(
			{
				consumer: 'chat',
				signal,
				onAdmitted: () => {
					isWaitingForSlot = false;
				}
			},
			() =>
				runAgentLoop({
					messages: messagesForApi,
					workingDir: currentWorkingDir,
					maxIterations: exhaustiveResearch ? 25 : 10,
					contextSize: activeCtxSize,
					deepResearch: exhaustiveResearch,
					expectsFileOutput,
					visionSupported,
					signal,
					onUsageUpdate: (u: Usage) => {
						updateContextUsage(u, activeCtxSize);
						conversation.contextUsage = {
							promptTokens: u.prompt_tokens,
							completionTokens: u.completion_tokens
						};
					},
					onCallStats: (stats) => {
						turnStats.lastCallStats = stats;
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
							s.id === call.id
								? { ...s, status: 'done' as const, result, thumbDataUrl, artifacts }
								: s
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

						if (finalContent) {
							logDebug('chat', 'onComplete commit', {
								rawStreamingLen: streamingContent.length,
								finalContentLen: finalContent.length,
								citedUrls: processed.citedUrls
							});
							commitMessage(conversation, finalContent, turnStats);
							if (exhaustiveResearch) exhaustiveResearch = false;
						} else {
							const diagnosis = diagnoseEmptyResponse(conversation.searchSteps, streamingContent);
							logDebug('chat', `onComplete empty → diagnosis ${diagnosis.type}`, {
								rawStreamingLen: streamingContent.length,
								rawStreamingPreview: streamingContent.slice(0, 2000),
								diagnosis
							});
							if (diagnosis.type === 'commit') {
								commitMessage(conversation, diagnosis.content, turnStats);
								if (exhaustiveResearch) exhaustiveResearch = false;
							} else {
								errorMessage = diagnosis.message;
								errorTurnId = currentTurnId;
							}
						}
						conversation.sourceUrls = processed.citedUrls;
					},
					onError: handleTurnError
				})
		);

		captureToolPairsForNextTurn(conversation, messagesForApi, baseMessageCount, keepRecentTools);
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			commitPartialOnAbort(conversation, turnStats);
		} else {
			handleTurnError(e);
		}
	} finally {
		isGenerating = false;
		isWaitingForSlot = false;
		streamingContent = '';
		abortController = null;
		conversation.updatedAt = Date.now();
	}
}
