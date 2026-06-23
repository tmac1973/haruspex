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
import { getSettings } from '$lib/stores/settings';

/** Target width for the terminal half of a freshly detached window. */
const DETACHED_TERMINAL_TARGET = 760;

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

	await stashHandoff(ptyId, session.serializeChat(), session.serializeTerminal());

	// Size the window so the terminal gets a comfortable width alongside the
	// (saved) sidebar width — otherwise a wide sidebar swamps a fixed-width
	// window and the user has to resize on every detach.
	const sidebarWidth = Math.round(getSettings().shellSidebarWidth);
	const w = new WebviewWindow(`shell-${ptyId}`, {
		url: `/shell/${ptyId}`,
		title: session.name,
		width: DETACHED_TERMINAL_TARGET + sidebarWidth,
		height: 700,
		// Let the DOM receive image drops in the chat sidebar; without this the
		// webview swallows OS file drops as native tauri://drag-drop events.
		dragDropEnabled: false
	});
	w.once('tauri://error', (e) => console.error('detached shell window error', e));

	detachShellSession(session.id);
}

/**
 * From inside a detached window: hand the shell back to the main window and
 * close. The PTY survives (Terminal no longer kills on unmount); the main
 * window's listener re-attaches and re-hydrates the stashed chat + scrollback.
 */
export async function handBackToMain(
	ptyId: number,
	chatJson: string,
	name: string,
	scrollback: string
): Promise<void> {
	await stashHandoff(ptyId, chatJson, scrollback);
	await emit(REATTACH_EVENT, { ptyId, name } satisfies ReattachPayload);
}

/** Stash the chat thread + serialized terminal grid for the adopting window. */
async function stashHandoff(ptyId: number, chatJson: string, scrollback: string): Promise<void> {
	await invoke('shell_stash_chat', { sessionId: ptyId, chat: chatJson }).catch((e) =>
		console.error('shell_stash_chat failed', e)
	);
	await invoke('shell_stash_scrollback', { sessionId: ptyId, data: scrollback }).catch((e) =>
		console.error('shell_stash_scrollback failed', e)
	);
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
