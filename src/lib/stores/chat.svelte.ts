import { type ChatMessage, type Usage, ApiError } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { getDisplayLabel } from '$lib/agent/tools';
import { shouldCompact, compactConversation } from '$lib/agent/compaction';
import { buildSystemPrompt, looksLikeFileOutputRequest, injectMessageHints } from '$lib/agent/system-prompt';
import { diagnoseEmptyResponse } from '$lib/agent/diagnostics';
import { getActiveContextSize, getSettings } from '$lib/stores/settings';
import { processCitations, renderMarkdown, stripToolCallArtifacts } from '$lib/markdown';
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
		contextUsage: null
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

export function getSearchSteps(): SearchStep[] {
	return searchSteps;
}

export function getSourceUrls(): string[] {
	if (isGenerating && streamingContent) {
		const fetched = extractUrlsFromSteps(searchSteps);
		const { citedUrls } = processCitations(streamingContent, fetched);
		return citedUrls;
	}
	return sourceUrls;
}

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
	searchSteps = [];
	sourceUrls = [];
	abortController = new AbortController();

	try {
		const currentWorkingDir = conversation.workingDir;
		const expectsFileOutput = !!currentWorkingDir && looksLikeFileOutputRequest(content);

		const historyMessages = conversation.messages.filter(
			(m) => m.role !== 'tool' && !m.tool_calls
		);
		let messagesForApi: ChatMessage[] = [
			buildSystemPrompt(currentWorkingDir),
			...historyMessages
		];

		messagesForApi = injectMessageHints(messagesForApi, {
			workingDir: currentWorkingDir,
			exhaustiveResearch
		});

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
				searchSteps = [
					...searchSteps,
					{
						id: call.id,
						toolName: call.name,
						query: getDisplayLabel(call.name, call.arguments),
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
				const fetched = extractUrlsFromSteps(searchSteps);
				const processed = processCitations(
					stripToolCallArtifacts(streamingContent).trim(),
					fetched
				);
				const finalContent = processed.content;

				const commit = (text: string) => {
					const assistantMsg: ChatMessage = { role: 'assistant', content: text };
					conversation.messages.push(assistantMsg);
					dbSaveMessage(conversation.id, assistantMsg);
					if (exhaustiveResearch) {
						exhaustiveResearch = false;
					}
				};

				if (finalContent) {
					commit(finalContent);
				} else {
					const diagnosis = diagnoseEmptyResponse(searchSteps, streamingContent);
					if (diagnosis.type === 'commit') {
						commit(diagnosis.content);
					} else {
						errorMessage = diagnosis.message;
					}
				}
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
				const fetched = extractUrlsFromSteps(searchSteps);
				const { content, citedUrls } = processCitations(streamingContent, fetched);
				const partialMsg: ChatMessage = { role: 'assistant', content };
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
