import { type ChatMessage, ApiError } from '$lib/api';
import { runAgentLoop, type SearchStep } from '$lib/agent/loop';
import { getResponseFormatPrompt } from '$lib/stores/settings';

function buildSystemPrompt(): ChatMessage {
	const today = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	return {
		role: 'system',
		content: `You are Haruspex, a helpful, private AI assistant running entirely on the user's computer. Nothing the user says ever leaves their device.

Today's date is ${today}. Your training data has a cutoff and may be outdated. The world has continued to evolve since your training — new products, technologies, events, and standards exist that you have no knowledge of.

CRITICAL RULES:
- NEVER tell the user that something does not exist just because you haven't heard of it. If the user mentions a product, technology, or event you don't recognize, ASSUME IT IS REAL and search for it.
- NEVER "correct" the user by substituting something you do know for something you don't. If the user asks about "X870 motherboards", do NOT respond about X570 or X670 instead.
- When in doubt about whether something exists or is current, ALWAYS search first before answering.
- Trust the user's knowledge of current events over your training data.

RULES FOR TOOL USE:
- Use web_search when the question involves products, current events, recent releases, comparisons, recommendations, or anything that may have changed since your training.
- Do NOT search for greetings, creative writing, coding help, math, or general conversation.
- Do NOT search for information about yourself.
- If you decide to search, ONLY call the tool. Do NOT write an answer before receiving search results.
- When you search, use a concise, specific query. Then optionally use fetch_url on 1-3 relevant results for more detail.
- Always cite sources by mentioning the website name. Never fabricate URLs.

Be concise, accurate, and helpful. If you don't know something, search for it rather than guessing.

${getResponseFormatPrompt()}`
	};
}

export interface Conversation {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

let conversations = $state<Conversation[]>([]);
let activeConversationId = $state<string | null>(null);
let isGenerating = $state(false);
let streamingContent = $state('');
let errorMessage = $state<string | null>(null);
let searchSteps = $state<SearchStep[]>([]);
let sourceUrls = $state<string[]>([]);

let abortController: AbortController | null = null;

function generateId(): string {
	return crypto.randomUUID();
}

function generateTitle(content: string): string {
	return content.slice(0, 50).replace(/\n/g, ' ').trim() || 'New chat';
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

export function createConversation(): string {
	const id = generateId();
	const now = Date.now();
	conversations.unshift({
		id,
		title: 'New chat',
		messages: [],
		createdAt: now,
		updatedAt: now
	});
	activeConversationId = id;
	errorMessage = null;
	return id;
}

export function setActiveConversation(id: string): void {
	if (conversations.some((c) => c.id === id)) {
		activeConversationId = id;
		errorMessage = null;
	}
}

export function deleteConversation(id: string): void {
	conversations = conversations.filter((c) => c.id !== id);
	if (activeConversationId === id) {
		activeConversationId = conversations.length > 0 ? conversations[0].id : null;
	}
}

export function clearAllConversations(): void {
	if (isGenerating) cancelGeneration();
	conversations = [];
	activeConversationId = null;
	errorMessage = null;
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
		}
	}
	return [...new Set(urls)];
}

export async function sendMessage(content: string): Promise<void> {
	if (!content.trim() || isGenerating) return;

	if (!activeConversationId) {
		createConversation();
	}

	const conversation = getActiveConversation();
	if (!conversation) return;

	if (conversation.messages.length === 0) {
		conversation.title = generateTitle(content);
	}

	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();

	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	searchSteps = [];
	sourceUrls = [];
	abortController = new AbortController();

	try {
		const messagesForApi: ChatMessage[] = [buildSystemPrompt(), ...conversation.messages];

		await runAgentLoop({
			messages: messagesForApi,
			signal: abortController.signal,
			onToolStart: (call) => {
				const query =
					call.name === 'web_search'
						? (call.arguments.query as string)
						: (call.arguments.url as string);
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
				if (chunk.delta.content) {
					streamingContent += chunk.delta.content;
				}
			},
			onComplete: () => {
				const finalContent = streamingContent;
				if (finalContent) {
					conversation.messages.push({ role: 'assistant', content: finalContent });
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
				conversation.messages.push({
					role: 'assistant',
					content: streamingContent
				});
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
