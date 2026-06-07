/**
 * Detach / re-attach plumbing for shell tabs (plan Phase 3).
 *
 * A detached shell lives in its own OS window. The PTY itself never moves —
 * it's owned by Rust and shared across windows; "detach" just changes which
 * webview renders it. The chat thread can't cross JS contexts, so it's handed
 * off through a Rust stash (shell_stash_chat / shell_take_chat); the terminal
 * scrollback is replayed from a Rust ring (shell_get_scrollback).
 */

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

import {
	detachShellSession,
	reattachShellSession,
	type ShellSession
} from '$lib/stores/shell.svelte';

/** Event a detached window emits to hand its shell back to the main window. */
const REATTACH_EVENT = 'shell://reattach';

interface ReattachPayload {
	ptyId: number;
	name?: string;
}

/**
 * Pop a shell tab out into its own window. Stashes the chat, opens a window
 * pointed at the detached-shell route, then drops the tab from this window's
 * registry (without killing the PTY — the new window adopts it).
 */
export async function openDetachedShell(session: ShellSession): Promise<void> {
	const ptyId = session.boundSessionId;
	if (ptyId == null) return; // terminal not ready yet — nothing to detach

	await invoke('shell_stash_chat', { sessionId: ptyId, chat: session.serializeChat() }).catch((e) =>
		console.error('shell_stash_chat failed', e)
	);

	const w = new WebviewWindow(`shell-${ptyId}`, {
		url: `/shell/${ptyId}`,
		title: session.name,
		width: 900,
		height: 640
	});
	w.once('tauri://error', (e) => console.error('detached shell window error', e));

	detachShellSession(session.id);
}

/**
 * From inside a detached window: hand the shell back to the main window and
 * close. The PTY survives (Terminal no longer kills on unmount); the main
 * window's listener re-attaches and re-hydrates the stashed chat.
 */
export async function handBackToMain(ptyId: number, chatJson: string, name: string): Promise<void> {
	await invoke('shell_stash_chat', { sessionId: ptyId, chat: chatJson }).catch((e) =>
		console.error('shell_stash_chat failed', e)
	);
	await emit(REATTACH_EVENT, { ptyId, name } satisfies ReattachPayload);
}

/**
 * Main-window-only: listen for detached windows handing shells back and
 * re-attach them into the tab strip. Returns an unlisten fn.
 */
export function listenForReattach(): Promise<UnlistenFn> {
	return listen<ReattachPayload>(REATTACH_EVENT, (event) => {
		reattachShellSession(event.payload.ptyId, event.payload.name);
	});
}
