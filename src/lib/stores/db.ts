import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '$lib/api';

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

export interface DbConversationSummary {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
}

// Marker prefix for multimodal content arrays stored in the DB.
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

let available = false;

export function isDbAvailable(): boolean {
	return available;
}

export async function initDb(): Promise<{
	available: boolean;
	summaries: DbConversationSummary[];
}> {
	try {
		const summaries = await invoke<DbConversationSummary[]>('db_list_conversations');
		available = true;
		return { available: true, summaries };
	} catch {
		available = false;
		return { available: false, summaries: [] };
	}
}

export async function dbSaveMessage(conversationId: string, msg: ChatMessage): Promise<void> {
	if (!available) return;
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

export async function dbCreateConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_create_conversation', { id, title });
	} catch {
		// non-fatal
	}
}

export async function dbRenameConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_rename_conversation', { id, title });
	} catch {
		// non-fatal
	}
}

export async function dbDeleteConversation(id: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_delete_conversation', { id });
	} catch {
		// non-fatal
	}
}

export async function dbClearAll(): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_clear_all_conversations');
	} catch {
		// non-fatal
	}
}

export async function dbLoadMessages(id: string): Promise<ChatMessage[]> {
	if (!available) return [];
	try {
		const full = await invoke<DbConversation>('db_get_conversation', { id });
		return full.messages.map(dbMessageToChatMessage);
	} catch {
		return [];
	}
}

export async function dbReplaceMessages(
	conversationId: string,
	messages: ChatMessage[]
): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_replace_messages', {
			conversationId,
			messages: messages.map((m) => ({
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
