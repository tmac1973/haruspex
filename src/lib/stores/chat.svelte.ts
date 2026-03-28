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
- Optionally use fetch_url on 1-3 relevant results for detail.
- Always cite sources. Never fabricate URLs.

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
