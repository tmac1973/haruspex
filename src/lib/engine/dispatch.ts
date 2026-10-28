/**
 * The operations, run in the window that has the session. Rust's hub routes
 * each one here (`src-tauri/src/engine/`): to the session's owner, to the
 * main window for a session open nowhere (and for chat, jobs and settings),
 * and to every window for the listings. Each answers at once; `session.send` answers when the turn has
 * started, and its progress arrives as events.
 */
import { invoke } from '@tauri-apps/api/core';
import { ioRoot, relativeToRoot } from '#lib/code/paths.ts';
import { listCodeSessions, wslDistros } from '#lib/code/db.ts';
import { logDebug } from '#lib/debugLog.ts';
import {
	getOpenSessions,
	newSession,
	openSession,
	type CodeSession
} from '#lib/stores/code.svelte.ts';
import { errMessage } from '#lib/utils/error.ts';
import { newSessionBeside } from '#lib/code/windows.ts';
import { shellProject } from '#lib/skills/project.ts';
import { attachImages, slashFor } from '#lib/engine/attach.ts';
import { answerPrompt, currentPrompts } from '#lib/engine/prompts.svelte.ts';
import { sessionState } from '#lib/engine/state.ts';
import type { EngineOp, FileContent, SessionListItem } from '#lib/engine/types.ts';

export const MAIN_WINDOW = 'main';

/** The most of one file `session.readFile` sends: plenty to read, not a memory event. */
export const MAX_FILE_CHARS = 1_000_000;

/**
 * A file in the session's folder, read through the same confined command the
 * agent's tools use (a WSL session's through its distro's share). A path
 * outside the folder is refused here and again in Rust.
 */
async function readFile(s: CodeSession, path: string): Promise<FileContent> {
	const rel = relativeToRoot(s.root, path);
	if (!rel) throw new Error(`${path} is outside the session's folder`);
	const content = await invoke<string>('fs_read_text_full', {
		workdir: ioRoot(s.root, s.wslDistro),
		relPath: rel
	});
	return content.length > MAX_FILE_CHARS
		? { path: rel, content: content.slice(0, MAX_FILE_CHARS), truncated: true }
		: { path: rel, content, truncated: false };
}

let resync: ((id: string) => boolean) | null = null;
let resyncChat: ((id: string) => boolean) | null = null;

/** How `session.resync` reaches the session watchers (`watch.svelte.ts`). */
export function setResync(fn: (id: string) => boolean): void {
	resync = fn;
}

/** How `chat.resync` reaches the chat watcher (`chat.svelte.ts`), main window only. */
export function setChatResync(fn: (id: string) => boolean): void {
	resyncChat = fn;
}

/** What the Code tab's input box lends `/name` (`CodePane.svelte`), for a send from elsewhere. */
function codeSlashHost(s: CodeSession, addNote: (text: string) => void) {
	return {
		projectRoot: async () =>
			s.projectRoot ?? (await shellProject(ioRoot(s.root, s.wslDistro))).root,
		codeMode: () => true,
		// `/new`: a new session in the same folder, as a sub-tab.
		newConversation: () => newSessionBeside(s),
		// Answers at once, as `session.compact` does; the summary arrives as a meta event.
		compact: async (instructions: string) => {
			if (!s.canCompact()) {
				addNote('Nothing to summarise yet: the conversation is still short.');
				return;
			}
			void s.compactNow(instructions).catch((e: unknown) => {
				logDebug('engine', 'compact failed', { id: s.id, error: errMessage(e) });
			});
		}
	};
}

function openHere(id: string): CodeSession {
	const s = getOpenSessions().find((x) => x.id === id);
	if (!s) throw new Error(`session ${id} is not open: open it first (session.open)`);
	return s;
}

async function listSessions(label: string): Promise<SessionListItem[]> {
	const open: SessionListItem[] = getOpenSessions().map((s) => ({
		id: s.id,
		title: s.title,
		root: s.root,
		wslDistro: s.wslDistro,
		status: s.status,
		window: label
	}));
	// The saved list once, from the main window; Rust keeps the open entry
	// for a session that is open somewhere.
	if (label !== MAIN_WINDOW) return open;
	const saved = await listCodeSessions();
	const openIds = new Set(open.map((s) => s.id));
	return [
		...open,
		...saved
			.filter((s) => !openIds.has(s.id))
			.map((s) => ({
				id: s.id,
				title: s.title,
				root: s.root,
				wslDistro: s.wsl_distro ?? null,
				status: null,
				window: null
			}))
	];
}

export async function dispatch(op: EngineOp, label: string): Promise<unknown> {
	switch (op.type) {
		case 'sessions.list':
			return listSessions(label);
		case 'session.get':
			return sessionState(openHere(op.id));
		case 'session.open': {
			const s = await openSession(op.id);
			// Null: another window had it after all, and is in front now.
			return s ? { id: s.id, window: label } : { id: op.id, window: null };
		}
		case 'session.new': {
			const s = await newSession(op.root, {
				effort: op.effort ?? null,
				wslDistro: op.wslDistro ?? null,
				worktree: op.worktree === true
			});
			return { id: s.id, root: s.root, wslDistro: s.wslDistro, window: label };
		}
		case 'wsl.distros':
			return wslDistros();
		case 'session.send': {
			const s = openHere(op.id);
			const images = await attachImages(op.images);
			if (!op.text.trim() && images.length === 0) throw new Error('nothing to send');
			if (s.folderMissing) throw new Error(`the session's folder is missing: ${s.root}`);
			const steered = s.busy;
			// As the input box: no `/name` mid-turn, where it is steering.
			const slash = steered
				? null
				: await slashFor(op.text, (addNote) => codeSlashHost(s, addNote));
			if (slash?.kind === 'handled') return { handled: true, note: slash.note, id: slash.id };
			// Resolves when the turn ends; its progress goes out as events.
			void s.send(op.text, { remote: true, images, skill: slash?.skill }).catch((e: unknown) => {
				logDebug('engine', 'send failed', { id: s.id, error: errMessage(e) });
			});
			return steered ? { steered: true } : { started: true };
		}
		case 'session.compact': {
			const s = openHere(op.id);
			if (s.busy) throw new Error('the session is busy; try again when its turn ends');
			if (!s.canCompact()) return { started: false, reason: 'nothing to summarise yet' };
			// Answers at once, as every operation does; the summary arrives as
			// a meta event (`compaction`), a failure as `lastError`.
			void s.compactNow(op.instructions ?? '').catch((e: unknown) => {
				logDebug('engine', 'compact failed', { id: s.id, error: errMessage(e) });
			});
			return { started: true };
		}
		case 'session.stop': {
			const s = openHere(op.id);
			const running = s.busy;
			s.stop();
			return { stopping: running };
		}
		case 'session.cancelShellWait': {
			const s = openHere(op.id);
			const waiting = !!s.shellWait;
			s.cancelShellWait();
			return { cancelled: waiting };
		}
		case 'session.readFile':
			return readFile(openHere(op.id), op.path);
		case 'session.resync':
			openHere(op.id);
			if (!resync?.(op.id)) throw new Error(`session ${op.id} is not being watched`);
			return { resynced: op.id };
		case 'chats.list':
		case 'chat.get':
		case 'chat.new':
		case 'chat.send':
		case 'chat.stop':
		case 'chat.continue':
		case 'chat.retry':
			if (label !== MAIN_WINDOW) throw new Error('chat runs in the main window');
			return (await import('#lib/engine/chat.svelte.ts')).dispatchChat(op);
		case 'chat.resync':
			if (!resyncChat?.(op.id)) throw new Error(`chat ${op.id} isn't the open chat`);
			return { resynced: op.id };
		case 'jobs.types':
		case 'jobs.list':
		case 'jobs.get':
		case 'jobs.create':
		case 'jobs.update':
		case 'jobs.duplicate':
		case 'jobs.delete':
		case 'jobs.run':
		case 'run.cancel':
		case 'runs.list':
		case 'runs.get':
		case 'runs.current':
		case 'runs.delete':
		case 'runs.resync':
			if (label !== MAIN_WINDOW) throw new Error('jobs run in the main window');
			return (await import('#lib/engine/jobs.svelte.ts')).dispatchJobs(op);
		case 'debug.tail':
			return (await import('#lib/engine/observe.ts')).dispatchObserve(op, label);
		case 'inference.queue':
		case 'tasks.list':
		case 'tasks.cancel':
			if (label !== MAIN_WINDOW) throw new Error('the main window answers for the queue and tasks');
			return (await import('#lib/engine/observe.ts')).dispatchObserve(op, label);
		case 'settings.get':
		case 'settings.patch': {
			if (label !== MAIN_WINDOW) throw new Error('settings are changed in the main window');
			const { patchSettings, readSettings } = await import('#lib/engine/settings.ts');
			return op.type === 'settings.get' ? readSettings(op.keys) : patchSettings(op.patch);
		}
		case 'prompts.list':
			return currentPrompts(label);
		case 'prompts.answer':
			await answerPrompt(label, op.promptId, op.answer);
			return { answered: op.promptId };
		default:
			throw new Error(`unknown operation ${(op as { type?: string }).type}`);
	}
}
