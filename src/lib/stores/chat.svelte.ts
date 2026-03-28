import { chatCompletionStream, type ChatMessage, ApiError } from '$lib/api';

const SYSTEM_PROMPT: ChatMessage = {
	role: 'system',
	content: `You are Haruspex, a helpful AI assistant running locally on the user's computer.
You are private — nothing the user says leaves their device.
Be concise, accurate, and helpful. If you don't know something, say so.`
};

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

export async function sendMessage(content: string): Promise<void> {
	if (!content.trim() || isGenerating) return;

	// Ensure we have an active conversation
	if (!activeConversationId) {
		createConversation();
	}

	const conversation = getActiveConversation();
	if (!conversation) return;

	// Update title from first user message
	if (conversation.messages.length === 0) {
		conversation.title = generateTitle(content);
	}

	// Add user message
	const userMessage: ChatMessage = { role: 'user', content: content.trim() };
	conversation.messages.push(userMessage);
	conversation.updatedAt = Date.now();

	// Start generation
	isGenerating = true;
	streamingContent = '';
	errorMessage = null;
	abortController = new AbortController();

	try {
		// Build messages array with system prompt
		const messagesForApi: ChatMessage[] = [SYSTEM_PROMPT, ...conversation.messages];

		const stream = chatCompletionStream({ messages: messagesForApi }, abortController.signal);

		for await (const chunk of stream) {
			if (chunk.delta.content) {
				streamingContent += chunk.delta.content;
			}
		}

		// Finalize: add assistant message
		const finalContent = streamingContent;
		if (finalContent) {
			conversation.messages.push({ role: 'assistant', content: finalContent });
		} else {
			errorMessage = 'Model returned an empty response. Try rephrasing.';
		}
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			// User cancelled — save partial content if any
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
