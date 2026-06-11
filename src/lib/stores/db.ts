import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '$lib/api';
import { logDebug } from '$lib/debug-log';

interface DbMessage {
	role: string;
	content: string;
	tool_calls: string | null;
	tool_call_id: string | null;
	/** JSON-serialized SearchStep[] (artifacts + thumbDataUrl + args)
	 *  captured for assistant messages so inline images / DataFrames /
	 *  plots survive an app restart. */
	steps: string | null;
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
	} catch (e) {
		// DB unavailable is non-fatal — the app falls back to in-memory
		// state. Still log so a corrupt DB or schema-mismatch isn't
		// totally invisible.
		logDebug('db', 'initDb failed', { error: String(e) });
		available = false;
		return { available: false, summaries: [] };
	}
}

export async function dbSaveMessage(
	conversationId: string,
	msg: ChatMessage,
	stepsJson?: string | null
): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_save_message', {
			conversationId,
			role: msg.role,
			content: serializeContent(msg.content),
			toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
			toolCallId: msg.tool_call_id || null,
			steps: stepsJson ?? null
		});
	} catch (e) {
		logDebug('db', 'dbSaveMessage failed', { conversationId, error: String(e) });
	}
}

/** Update the `steps` JSON on the most recently inserted message in
 *  a conversation. Used after an agent turn completes — the assistant
 *  message was already persisted at stream-time; the artifacts get
 *  attached afterwards. */
export async function dbUpdateLastMessageSteps(
	conversationId: string,
	stepsJson: string | null
): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_update_last_message_steps', {
			conversationId,
			steps: stepsJson
		});
	} catch (e) {
		logDebug('db', 'dbUpdateLastMessageSteps failed', { conversationId, error: String(e) });
	}
}

/** Load the conversation's persisted messageSteps map. Returns
 *  Record<messageIndex, SearchStep[]> shaped for direct assignment to
 *  Conversation.messageSteps. */
export async function dbLoadMessageSteps(id: string): Promise<Record<number, unknown[]>> {
	if (!available) return {};
	try {
		const full = await invoke<DbConversation>('db_get_conversation', { id });
		const out: Record<number, unknown[]> = {};
		full.messages.forEach((m, i) => {
			if (m.steps) {
				try {
					const parsed = JSON.parse(m.steps);
					if (Array.isArray(parsed)) out[i] = parsed;
				} catch {
					// ignore corrupt rows
				}
			}
		});
		return out;
	} catch (e) {
		logDebug('db', 'dbLoadMessageSteps failed', { id, error: String(e) });
		return {};
	}
}

export async function dbCreateConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_create_conversation', { id, title });
	} catch (e) {
		logDebug('db', 'dbCreateConversation failed', { id, error: String(e) });
	}
}

export async function dbRenameConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_rename_conversation', { id, title });
	} catch (e) {
		logDebug('db', 'dbRenameConversation failed', { id, error: String(e) });
	}
}

export async function dbDeleteConversation(id: string): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_delete_conversation', { id });
	} catch (e) {
		logDebug('db', 'dbDeleteConversation failed', { id, error: String(e) });
	}
}

export async function dbClearAll(): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_clear_all_conversations');
	} catch (e) {
		logDebug('db', 'dbClearAll failed', { error: String(e) });
	}
}

export async function dbLoadMessages(id: string): Promise<ChatMessage[]> {
	if (!available) return [];
	try {
		const full = await invoke<DbConversation>('db_get_conversation', { id });
		return full.messages.map(dbMessageToChatMessage);
	} catch (e) {
		logDebug('db', 'dbLoadMessages failed', { id, error: String(e) });
		return [];
	}
}

export async function dbReplaceMessages(
	conversationId: string,
	messages: ChatMessage[],
	stepsByIndex?: Record<number, unknown[]>
): Promise<void> {
	if (!available) return;
	try {
		await invoke('db_replace_messages', {
			conversationId,
			messages: messages.map((m, i) => ({
				role: m.role,
				content: serializeContent(m.content),
				tool_calls: m.tool_calls ? JSON.stringify(m.tool_calls) : null,
				tool_call_id: m.tool_call_id || null,
				// Without this, replacing messages (compaction) silently
				// wiped every persisted per-message artifact.
				steps: stepsByIndex?.[i] ? JSON.stringify(stepsByIndex[i]) : null
			}))
		});
	} catch (e) {
		logDebug('db', 'dbReplaceMessages failed', { conversationId, error: String(e) });
	}
}
