// Ambient session identity shared by the chat store and the sandbox / worker
// layer: the active conversation id and the active working directory.
//
// These live in their own leaf module so `sandbox/*` and `worker-manager`
// can read them WITHOUT importing the chat store. Importing chat from the
// sandbox layer used to create a runtime import cycle
// (chat -> sandbox -> chat, and chat -> sandbox -> worker-pool ->
// worker-manager -> chat). The chat store owns all the orchestration; this
// module only holds the two primitive values it broadcasts.

let activeConversationId = $state<string | null>(null);
let workingDir = $state<string | null>(null);

export function getActiveConversationId(): string | null {
	return activeConversationId;
}

export function setActiveConversationId(id: string | null): void {
	activeConversationId = id;
}

export function getWorkingDir(): string | null {
	return workingDir;
}

/**
 * Set the raw working-dir value. This is the plain state write; the chat
 * store's `setWorkingDir` wraps it with persistence + sandbox-reset side
 * effects. Call that, not this, from app code.
 */
export function setWorkingDirState(path: string | null): void {
	workingDir = path;
}
