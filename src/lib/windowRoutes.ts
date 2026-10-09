/**
 * The routes that are windows of their own rather than the main window. They
 * load the same root layout, which must not re-run app bootstrap or draw the
 * main chrome for them (see `routes/+layout.svelte`).
 */

/** A detached Shell, a detached Code session, or an editor window. */
export function isDetachedRoute(routeId: string | null): boolean {
	return routeId === '/shell/[id]' || routeId === '/code/[id]' || routeId === '/editor';
}

/**
 * Detached windows that run agent turns, and so must show their approval
 * modals: each window has its own approval stores, and a question raised in
 * one has nowhere else to appear. Editor windows run no agent.
 */
export function rendersAgentModals(routeId: string | null): boolean {
	return routeId === '/shell/[id]' || routeId === '/code/[id]';
}
