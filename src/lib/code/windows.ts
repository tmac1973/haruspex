/**
 * Detached Code windows: one session in a window of its own.
 *
 * Nothing live crosses windows. The database holds the thread and Rust holds
 * the background processes, so detaching is "close the sub-tab here, open
 * the session there": `handOffSession` releases it (with its background
 * watches as the handoff) and the new window's `openSession` claims it.
 * Re-attaching is the same the other way, through `code://reattach`.
 *
 * The window is `code-<id>` on `/code/<id>`. Only an idle session moves; a
 * turn can't cross windows.
 */
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import type { Prefill } from '#lib/code/fork.ts';
import { sessionLabel } from '#lib/code/sessionList.ts';
import { openShellForCommand } from '#lib/code/shellBridge.ts';
import { serveShellRelay, type RelayBus } from '#lib/code/shellRelay.ts';
import { createCodeSession } from '#lib/code/db.ts';
import {
	forkAndOpen,
	forkSession,
	handOffSession,
	newSession,
	openSession,
	type CodeSession
} from '#lib/stores/code.svelte.ts';

/** Detached window → main: open this session here as a sub-tab. */
export const REATTACH_EVENT = 'code://reattach';

export interface ReattachPayload {
	id: string;
	/** For a fork made in a detached window: what its input box starts with. */
	prefill?: Prefill | null;
}

export function codeWindowLabel(id: string): string {
	return `code-${id}`;
}

export function codeWindowUrl(id: string): string {
	return `/code/${encodeURIComponent(id)}`;
}

/** `<session> — Haruspex Code`. */
export function codeWindowTitle(session: { title: string; root: string }): string {
	return `${sessionLabel(session)} — Haruspex Code`;
}

/** Why a session can't move windows right now, or null when it can. */
export function moveBlockedReason(session: Pick<CodeSession, 'status'>): string | null {
	switch (session.status) {
		case 'idle':
			return null;
		case 'waiting-shell':
			return 'Waiting for a command in the Shell tab. Finish or cancel it first.';
		case 'queued':
			return 'Waiting for another turn. Stop it, or wait until it is done.';
		default:
			return 'A turn is running. Stop it, or wait until it is done.';
	}
}

/** The window side of a move, injected so the rules can be tested without Tauri. */
export interface CodeWindowApi {
	/** Open `code-<id>`; rejects when the window can't be made. */
	create(id: string, title: string): Promise<void>;
	emitToMain(event: string, payload: unknown): Promise<void>;
	raiseMain(): Promise<void>;
	/** Close this window without asking. */
	closeSelf(): Promise<void>;
}

let detached = false;

/** Called by the `/code/[id]` page: this JS context is a detached window. */
export function markDetachedCodeWindow(): void {
	detached = true;
}

export function inDetachedCodeWindow(): boolean {
	return detached;
}

/**
 * Move a session from this window's tab strip into a window of its own.
 * False, doing nothing, while it isn't idle. If the window can't be made,
 * the session comes back as a sub-tab.
 */
export async function detachSession(
	session: CodeSession,
	api: CodeWindowApi = tauriApi
): Promise<boolean> {
	if (moveBlockedReason(session)) return false;
	const title = codeWindowTitle(session);
	if (!(await handOffSession(session.id))) return false;
	try {
		await api.create(session.id, title);
	} catch (e) {
		await openSession(session.id);
		throw e;
	}
	return true;
}

/**
 * From a detached window: give the session back to the main window, which
 * opens it as a sub-tab, and close this window. False while it isn't idle.
 */
export async function reattachToMain(
	session: CodeSession,
	api: CodeWindowApi = tauriApi
): Promise<boolean> {
	if (moveBlockedReason(session)) return false;
	if (!(await handOffSession(session.id))) return false;
	await api.emitToMain(REATTACH_EVENT, { id: session.id } satisfies ReattachPayload);
	await api.closeSelf();
	return true;
}

/**
 * "Fork from here". The fork opens as a sub-tab: here in the main window, or
 * in the main window (brought to the front) from a detached one, which only
 * ever shows its own session.
 */
export async function forkFromMessage(
	session: CodeSession,
	index: number,
	api: CodeWindowApi = tauriApi
): Promise<void> {
	if (!inDetachedCodeWindow()) {
		await forkAndOpen(session.id, index);
		return;
	}
	const fork = await forkSession(session.id, index);
	await api.emitToMain(REATTACH_EVENT, {
		id: fork.id,
		prefill: fork.prefill
	} satisfies ReattachPayload);
	await api.raiseMain();
}

/**
 * `/new` in a session: a new session in the same folder, as a sub-tab. From a
 * detached window that is the main window's tab strip too.
 */
export async function newSessionBeside(
	session: Pick<CodeSession, 'root'>,
	api: CodeWindowApi = tauriApi
): Promise<void> {
	if (!inDetachedCodeWindow()) {
		await newSession(session.root);
		return;
	}
	const record = await createCodeSession(session.root);
	await api.emitToMain(REATTACH_EVENT, { id: record.id } satisfies ReattachPayload);
	await api.raiseMain();
}

/**
 * Main window only: open what detached windows hand back. `onOpen` shows
 * the Code tab. Returns the handler, for tests; `listenInMainWindow` wires it.
 */
export function reattachHandler(
	onOpen: () => void,
	raiseMain: () => Promise<void>
): (p: ReattachPayload) => Promise<void> {
	return async (p) => {
		onOpen();
		const session = await openSession(p.id);
		if (session && p.prefill) session.prefill = p.prefill;
		await raiseMain();
	};
}

// ---- Tauri ----------------------------------------------------------------

export const tauriBus: RelayBus = {
	emitTo: (label, event, payload) => emitTo(label, event, payload),
	listen: (event, cb) => listen(event, (e) => cb(e.payload as never))
};

async function raiseSelf(): Promise<void> {
	const w = getCurrentWindow();
	await w.unminimize().catch(() => {});
	await w.setFocus().catch(() => {});
}

const tauriApi: CodeWindowApi = {
	create: (id, title) =>
		new Promise<void>((resolve, reject) => {
			const w = new WebviewWindow(codeWindowLabel(id), {
				url: codeWindowUrl(id),
				title,
				width: 900,
				height: 760,
				center: true
			});
			void w.once('tauri://created', () => resolve());
			void w.once('tauri://error', (e) => reject(new Error(String(e.payload))));
		}),
	emitToMain: (event, payload) => emitTo('main', event, payload),
	async raiseMain() {
		const main = await WebviewWindow.getByLabel('main').catch(() => null);
		await main?.unminimize().catch(() => {});
		await main?.setFocus().catch(() => {});
	},
	closeSelf: () => getCurrentWindow().destroy()
};

/**
 * Main window only: re-attach and fork requests from detached windows, and
 * their `open_in_shell` requests. Resolves to the function that stops both.
 */
export async function listenInMainWindow(onOpen: () => void): Promise<() => void> {
	const onReattach = reattachHandler(onOpen, raiseSelf);
	const stopReattach = await listen<ReattachPayload>(REATTACH_EVENT, (e) => {
		void onReattach(e.payload).catch((err: unknown) =>
			console.error('re-attaching a Code session failed', err)
		);
	});
	const stopRelay = await serveShellRelay(tauriBus, openShellForCommand, () => void raiseSelf());
	return () => {
		stopReattach();
		stopRelay();
	};
}
