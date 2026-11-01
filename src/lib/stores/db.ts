import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '#lib/api.ts';
import type { ConversationSummary } from '#lib/ipc/gen/ConversationSummary.ts';
import type { ConversationWithMessages } from '#lib/ipc/gen/ConversationWithMessages.ts';
import type { DbMessage } from '#lib/ipc/gen/DbMessage.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import { dbMutate, dbQuery } from '#lib/stores/dbCall.ts';

// ts-rs-generated mirrors of the Rust row types, re-exported under the
// names this module historically used.
type DbConversation = ConversationWithMessages;
export type DbConversationSummary = ConversationSummary;

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
			// The message still loads; only its tool calls are lost.
			logDebug('db', `message ${msg.id} has unparsable tool_calls; dropped`);
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
		logDebug('db', 'initDb failed', { error: errMessage(e) });
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
	await dbMutate({
		cmd: 'db_save_message',
		args: {
			conversationId,
			role: msg.role,
			content: serializeContent(msg.content),
			toolCalls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
			toolCallId: msg.tool_call_id || null,
			steps: stepsJson ?? null
		},
		category: 'db',
		onError: 'dbSaveMessage failed',
		ctx: { conversationId }
	});
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
	await dbMutate({
		cmd: 'db_update_last_message_steps',
		args: {
			conversationId,
			steps: stepsJson
		},
		category: 'db',
		onError: 'dbUpdateLastMessageSteps failed',
		ctx: { conversationId }
	});
}

/** Load the conversation's persisted messageSteps map. Returns
 *  Record<messageIndex, SearchStep[]> shaped for direct assignment to
 *  Conversation.messageSteps. */
export async function dbLoadMessageSteps(id: string): Promise<Record<number, unknown[]>> {
	if (!available) return {};
	const full = await dbQuery<DbConversation | null>({
		cmd: 'db_get_conversation',
		args: { id },
		category: 'db',
		onError: 'dbLoadMessageSteps failed',
		ctx: { id },
		fallback: null
	});
	const out: Record<number, unknown[]> = {};
	full?.messages.forEach((m, i) => {
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
}

export async function dbCreateConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'db_create_conversation',
		args: { id, title },
		category: 'db',
		onError: 'dbCreateConversation failed',
		ctx: { id }
	});
}

/**
 * Mark a conversation as never remembered — incognito, persisted.
 *
 * Remote web-chat threads are created this way. They are ordinary
 * `conversations` rows that appear in the owner's sidebar, so without this a
 * guest's statements would be distilled into the OWNER's memory the moment
 * the owner opened the thread and switched away. A visitor must not be able
 * to seed what the assistant believes.
 */
/**
 * Whether this conversation participates in memory. Defaults to true when the
 * row cannot be read — a conversation that has not loaded yet is an ordinary
 * one, and the two real gates (the global switch, and the Rust-side cursor
 * check on every extraction and recall) still hold.
 */
export async function dbGetConversationMemoryEnabled(conversationId: string): Promise<boolean> {
	if (!available) return true;
	const cursor = await dbQuery<{ memory_enabled: boolean } | null>({
		cmd: 'conversation_memory_cursor',
		args: { conversationId },
		category: 'db',
		onError: 'dbGetConversationMemoryEnabled failed',
		ctx: { conversationId },
		fallback: null
	});
	return cursor?.memory_enabled ?? true;
}

export async function dbSetConversationMemoryEnabled(
	conversationId: string,
	enabled: boolean
): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'conversation_set_memory_enabled',
		args: { conversationId, enabled },
		category: 'db',
		onError: 'dbSetConversationMemoryEnabled failed',
		ctx: { conversationId }
	});
}

export async function dbRenameConversation(id: string, title: string): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'db_rename_conversation',
		args: { id, title },
		category: 'db',
		onError: 'dbRenameConversation failed',
		ctx: { id }
	});
}

export async function dbSetUnread(id: string, unread: boolean): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'conversation_set_unread',
		args: { id, unread },
		category: 'db',
		onError: 'dbSetUnread failed',
		ctx: { id }
	});
}

/** A chat's folder; `null` (none) is stored as `''`. */
export async function dbSetWorkingDir(id: string, path: string | null): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'conversation_set_working_dir',
		args: { id, path: path ?? '' },
		category: 'db',
		onError: 'dbSetWorkingDir failed',
		ctx: { id }
	});
}

/** Give every chat saved before each had a folder of its own `path`. */
export async function dbAdoptWorkingDir(path: string | null): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'conversation_adopt_working_dir',
		args: { path: path ?? '' },
		category: 'db',
		onError: 'dbAdoptWorkingDir failed'
	});
}

export async function dbDeleteConversation(id: string): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'db_delete_conversation',
		args: { id },
		category: 'db',
		onError: 'dbDeleteConversation failed',
		ctx: { id }
	});
}

export async function dbClearAll(): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'db_clear_all_conversations',
		category: 'db',
		onError: 'dbClearAll failed'
	});
}

export async function dbLoadMessages(id: string): Promise<ChatMessage[]> {
	if (!available) return [];
	const full = await dbQuery<DbConversation | null>({
		cmd: 'db_get_conversation',
		args: { id },
		category: 'db',
		onError: 'dbLoadMessages failed',
		ctx: { id },
		fallback: null
	});
	return full ? full.messages.map(dbMessageToChatMessage) : [];
}

export async function dbReplaceMessages(
	conversationId: string,
	messages: ChatMessage[],
	stepsByIndex?: Record<number, unknown[]>
): Promise<void> {
	if (!available) return;
	await dbMutate({
		cmd: 'db_replace_messages',
		args: {
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
		},
		category: 'db',
		onError: 'dbReplaceMessages failed',
		ctx: { conversationId }
	});
}
