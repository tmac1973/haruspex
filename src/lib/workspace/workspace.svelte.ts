// Public surface for the workspace tab + (eventually) the unified
// python sandbox. Holds a singleton IframePool wired to real app
// settings + active chat. Components import these helpers; they do
// not construct an IframePool themselves.

import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { getSettings } from '$lib/stores/settings';
import { getWorkingDir } from '$lib/stores/chat.svelte';
import { IframePool, type Snapshot } from './iframe-pool';

let pool: IframePool | null = null;

// Chat ids whose stage has received fresh content the user has not
// yet viewed since their last Workspace visit. Drives the tab-bar
// badge and the once-per-turn auto-switch. SvelteSet integrates with
// $derived so consumers re-render on mutation.
const freshContent = new SvelteSet<string>();

// Per-chat one-shot guard: once auto-switch has fired for a given
// chat in the current turn, don't steal focus again until the next
// user message. No UI reads this directly, but the lint rule
// prefers SvelteSet uniformly so the file doesn't mix flavors.
const autoSwitchedThisTurn = new SvelteSet<string>();

let onStageWriteHook: ((chatId: string) => void) | null = null;

/**
 * Returns the shared IframePool, creating it lazily on first call.
 * Components should use this instead of `new IframePool(...)`.
 */
export function getWorkspacePool(): IframePool {
	if (!pool) {
		pool = new IframePool({
			cap: 3,
			getRuntimeConfig: () => ({
				proxyMode: getSettings().proxy?.mode ?? 'none',
				workingDir: getWorkingDir()
			}),
			getProxyConfig: () => {
				const p = getSettings().proxy;
				return { mode: p?.mode ?? 'none', url: p?.url ?? '' };
			},
			onStageWrite: (chatId) => {
				freshContent.add(chatId);
				onStageWriteHook?.(chatId);
			},
			onStageClear: (chatId) => {
				freshContent.delete(chatId);
			},
			onEvicted: (chatId, snap) => {
				// Step 8 persists this on the conversation row. For now
				// it lives in module state so the UI can render "you have
				// a frozen snapshot for this chat".
				lastEvictedSnapshots.set(chatId, snap);
			}
		});
	}
	return pool;
}

/**
 * One-time registration of the stage-write hook (the WorkspaceTab UI
 * sets this so it can run badge / auto-switch logic that lives on the
 * Svelte side). Calling again replaces the prior hook.
 */
export function setStageWriteHook(fn: ((chatId: string) => void) | null): void {
	onStageWriteHook = fn;
}

/** Mark this chat's fresh-content flag cleared (user viewed the tab). */
export function markFreshContentSeen(chatId: string): void {
	freshContent.delete(chatId);
}

export function hasFreshContent(chatId: string): boolean {
	return freshContent.has(chatId);
}

/** Per-turn auto-switch guard — read once per stage_write to decide focus. */
export function shouldAutoSwitch(chatId: string): boolean {
	if (autoSwitchedThisTurn.has(chatId)) return false;
	autoSwitchedThisTurn.add(chatId);
	return true;
}

/** Called from the chat store when the user sends a new message — resets
 *  the per-turn auto-switch flags so the next stage_write can steal focus. */
export function resetAutoSwitchForChat(chatId: string): void {
	autoSwitchedThisTurn.delete(chatId);
}

const lastEvictedSnapshots = new SvelteMap<string, Snapshot>();

export function getEvictedSnapshot(chatId: string): Snapshot | undefined {
	return lastEvictedSnapshots.get(chatId);
}

/** Test seam — replace the singleton pool. Production code never calls this. */
export function __setPoolForTesting(p: IframePool | null): void {
	pool = p;
}
