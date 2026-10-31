// Ambient session identity shared by the chat store and the sandbox / worker
// layer: the active conversation id and each conversation's working directory.
//
// These live in their own leaf module so `sandbox/*` and `worker-manager`
// can read them WITHOUT importing the chat store. Importing chat from the
// sandbox layer used to create a runtime import cycle
// (chat -> sandbox -> chat, and chat -> sandbox -> worker-pool ->
// worker-manager -> chat). The chat store owns all the orchestration; this
// module only holds the values it broadcasts.

import { SvelteMap } from 'svelte/reactivity';

let activeConversationId = $state<string | null>(null);
// The folder the next new chat starts in: Settings → Chat's default, or the
// one picked while no chat was open.
let defaultWorkingDir = $state<string | null>(null);
// Each conversation's folder; null for none.
const workingDirs = new SvelteMap<string, string | null>();

export function getActiveConversationId(): string | null {
	return activeConversationId;
}

export function setActiveConversationId(id: string | null): void {
	activeConversationId = id;
}

/** The open conversation's folder, or a new chat's when none is open. */
export function getWorkingDir(): string | null {
	return getWorkingDirFor(activeConversationId);
}

/** A conversation's folder; one the store doesn't know gets a new chat's. */
export function getWorkingDirFor(id: string | null): string | null {
	if (id !== null && workingDirs.has(id)) return workingDirs.get(id) ?? null;
	return defaultWorkingDir;
}

export function getDefaultWorkingDir(): string | null {
	return defaultWorkingDir;
}

/**
 * The plain state writes. The chat store's `setWorkingDir` wraps them with
 * persistence + sandbox-reset side effects. Call that, not these, from app
 * code.
 */
export function setDefaultWorkingDirState(path: string | null): void {
	defaultWorkingDir = path;
}

export function setWorkingDirState(id: string, path: string | null): void {
	workingDirs.set(id, path);
}

export function forgetWorkingDir(id: string): void {
	workingDirs.delete(id);
}

export function clearWorkingDirs(): void {
	workingDirs.clear();
}
