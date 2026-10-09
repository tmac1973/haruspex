/**
 * The single-owner rule for Code sessions: a session is open in one window
 * at a time. Rust keeps the map (`code_tools/claims.rs`); this is the
 * frontend's side of it.
 */
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CodeClaim } from '#lib/ipc/gen/CodeClaim.ts';
import type { CodeBgWatch } from '#lib/shell/backgroundWatch.ts';

/** What a window hands the next owner when a session moves. */
export interface Handoff {
	watches: CodeBgWatch[];
}

export interface Claimed {
	/** Null: this window owns the session now. Else the window that does. */
	owner: string | null;
	handoff: Handoff | null;
}

/**
 * Claim `id` for this window. A claim held by a window that no longer exists
 * counts as free.
 */
export async function claimSession(id: string): Promise<Claimed> {
	const res = await invoke<CodeClaim | null | undefined>('code_session_claim', { id });
	return { owner: res?.owner ?? null, handoff: parseHandoff(res?.handoff ?? null) };
}

/** Let go of `id`, leaving `handoff` for the next window that claims it. */
export async function releaseSession(id: string, handoff: Handoff | null = null): Promise<void> {
	await invoke('code_session_release', {
		id,
		handoff: handoff ? JSON.stringify(handoff) : null
	});
}

function parseHandoff(raw: string | null): Handoff | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Handoff>;
		return { watches: Array.isArray(parsed.watches) ? parsed.watches : [] };
	} catch {
		return null;
	}
}

/** Bring a window to the front. */
export async function raiseWindow(label: string): Promise<void> {
	const w = await WebviewWindow.getByLabel(label).catch(() => null);
	if (!w) return;
	await w.unminimize().catch(() => {});
	await w.setFocus().catch(() => {});
}
