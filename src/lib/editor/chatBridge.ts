/**
 * An editor window handing a command to the chat: the transcript viewer's
 * **Send to chat** puts `/fix-speech apply <edits file>` in the input box of
 * the conversation that works on the window's folder. Chats and Code
 * sessions live in the main window, so the editor emits to it; the main
 * window picks the most recent Chat or Code session whose folder holds the
 * file (a new Chat in that folder when there is none), fills its box, and
 * comes forward. Nothing is sent.
 */
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Editor → main: put this in a conversation's box. */
export const SEND_TO_CHAT_EVENT = 'editor://send-to-chat';

export interface SendToChatPayload {
	/** The folder the conversation must work in (or above). */
	folder: string;
	/** The command, before the path, e.g. `/fix-speech apply`. */
	command: string;
	/** An absolute path, given to the command relative to the conversation's folder. */
	path: string;
}

export async function sendToChat(p: SendToChatPayload): Promise<void> {
	await emitTo('main', SEND_TO_CHAT_EVENT, p);
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Whether `folder` is `dir` or inside it. */
export function holds(dir: string, folder: string): boolean {
	const d = norm(dir);
	const f = norm(folder);
	return d !== '' && (f === d || f.startsWith(`${d}/`));
}

/** `path` relative to `dir` when inside it, else as it is. */
export function relativeTo(dir: string, path: string): string {
	const d = norm(dir);
	const p = norm(path);
	return p.startsWith(`${d}/`) ? p.slice(d.length + 1) : p;
}

export interface Candidate {
	kind: 'chat' | 'code';
	id: string;
	folder: string | null;
	updatedAt: number;
}

/** The most recent conversation whose folder holds `folder`, if any. */
export function pickConversation(list: Candidate[], folder: string): Candidate | null {
	return (
		list
			.filter((c) => c.folder !== null && holds(c.folder, folder))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
	);
}

/** How the main window reaches its conversations: the stores, or fakes in tests. */
export interface ChatTargets {
	candidates(): Promise<Candidate[]>;
	fillChat(id: string, text: string): Promise<void>;
	fillCode(id: string, text: string): Promise<void>;
	newChat(folder: string, text: string): void;
	raise(): Promise<void>;
}

/** Main window: put the payload's command in the right conversation's box. */
export async function handleSendToChat(p: SendToChatPayload, t: ChatTargets): Promise<void> {
	const pick = pickConversation(await t.candidates(), p.folder);
	const dir = pick?.folder ?? p.folder;
	const text = `${p.command} ${relativeTo(dir, p.path)}`;
	if (!pick) t.newChat(p.folder, text);
	else if (pick.kind === 'code') await t.fillCode(pick.id, text);
	else await t.fillChat(pick.id, text);
	await t.raise();
}

async function storeTargets(): Promise<ChatTargets> {
	const chat = await import('#lib/stores/chat.svelte.ts');
	const session = await import('#lib/stores/session.svelte.ts');
	const code = await import('#lib/stores/code.svelte.ts');
	const { listCodeSessions } = await import('#lib/code/db.ts');
	const { setActiveTab } = await import('#lib/stores/activeTab.svelte.ts');
	return {
		candidates: async () => [
			...chat.getConversations().map((c) => ({
				kind: 'chat' as const,
				id: c.id,
				folder: session.getWorkingDirFor(c.id),
				updatedAt: c.updatedAt
			})),
			...(await listCodeSessions().catch(() => [])).map((s) => ({
				kind: 'code' as const,
				id: s.id,
				folder: s.root,
				updatedAt: s.updated_at
			}))
		],
		fillChat: async (id, text) => {
			setActiveTab('chat');
			await chat.setActiveConversation(id);
			chat.setConversationDraft(id, text);
		},
		fillCode: async (id, text) => {
			setActiveTab('code');
			const s = await code.openSession(id);
			if (s) s.prefill = { text, images: [] };
		},
		newChat: (folder, text) => {
			const id = chat.newConversationWithDraft(text);
			chat.setWorkingDir(folder, id);
			setActiveTab('chat');
		},
		raise: async () => {
			const w = getCurrentWindow();
			await w.unminimize().catch(() => {});
			await w.setFocus().catch(() => {});
		}
	};
}

/** Main window only: commands editor windows hand over. Resolves to the function that stops it. */
export async function listenForSendToChat(): Promise<() => void> {
	return listen<SendToChatPayload>(SEND_TO_CHAT_EVENT, (e) => {
		void storeTargets()
			.then((t) => handleSendToChat(e.payload, t))
			.catch((err: unknown) => console.error('Send to chat failed', err));
	});
}
