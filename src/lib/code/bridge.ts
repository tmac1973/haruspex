/**
 * The Shell's way into the Code tab: "Open in Code" makes a Code session
 * rooted at the shell's folder and shows it. The shell thread doesn't come
 * along.
 *
 * The shell store never imports the Code store, so this is a slot, like
 * `shellBridge.ts` the other way round: the Code store fills it when it loads
 * (`registerCodeOpener`) and the Shell calls `openCodeAt`.
 *
 * A detached Shell window shows no Code tab (the Code store loads there too,
 * but nothing renders it), so it installs a relay (`useCodeRelay`) that sends
 * the folder to the main window, whose listener opens it there.
 */

/** Detached Shell window → main window: open a Code session at `root`. */
export const OPEN_CODE_EVENT = 'code://open-at';

export interface OpenCodePayload {
	root: string;
}

export type CodeOpener = (root: string) => Promise<void>;

let opener: CodeOpener | null = null;
/** Takes precedence over `opener`. */
let relay: CodeOpener | null = null;

/** Called by the Code store when it loads. Returns the unregister. */
export function registerCodeOpener(fn: CodeOpener): () => void {
	opener = fn;
	return () => {
		if (opener === fn) opener = null;
	};
}

/** Called by a detached Shell window. Returns the unregister. */
export function useCodeRelay(fn: CodeOpener): () => void {
	relay = fn;
	return () => {
		if (relay === fn) relay = null;
	};
}

/** Start a Code session at `root` and switch to the Code tab. */
export async function openCodeAt(root: string): Promise<void> {
	const open = relay ?? opener;
	if (!open) throw new Error('The Code tab is not available here.');
	await open(root);
}

/** The relay a detached Shell window installs, with the window side injected. */
export function relayToMain(api: {
	emitToMain(event: string, payload: unknown): Promise<void>;
	raiseMain(): Promise<void>;
}): CodeOpener {
	return async (root) => {
		await api.emitToMain(OPEN_CODE_EVENT, { root } satisfies OpenCodePayload);
		await api.raiseMain();
	};
}
