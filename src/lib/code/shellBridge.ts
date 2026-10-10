/**
 * The one way the Code tab reaches a terminal: hand a command to a new Shell
 * tab, typed at the prompt but not run, and (for the agent's `open_in_shell`)
 * wait for the user to run it.
 *
 * The Code tab never imports the shell store, so this is a slot: the shell
 * store fills it when it loads (`registerShellCommandOpener`) and the Code side
 * calls through it. Nothing here knows how a shell tab is made.
 *
 * It also carries the "waiting for you in Shell N" state from the tool to the
 * Code session that ran it (`reportShellWait` / `setShellWaitListener`), so the
 * tool needs no handle on the session store either.
 */

export interface ShellCommandRequest {
	/** Typed at the prompt, never run: the user presses Enter. */
	command: string;
	/** Where the new shell starts: the Code session's folder. */
	cwd: string;
	/**
	 * The WSL distro the folder is in: the tab runs a shell there, whatever
	 * the Shell picker says, and starts at the Linux `cwd`.
	 */
	wslDistro?: string | null;
	/** Wait for the command to finish. False opens the tab and returns. */
	wait: boolean;
	/** Ends the wait. The shell tab stays open. */
	signal?: AbortSignal;
	/** The tab exists and holds the command. Called before any waiting. */
	onOpened?: (shell: OpenedShell) => void;
}

export interface OpenedShell {
	/** The tab's name, such as "Shell 2". */
	name: string;
	/** Show this tab in the Shell tab. */
	focus: () => void;
}

export type ShellCommandResult =
	/** The user ran a command there; it may differ from the one typed in. */
	| {
			kind: 'completed';
			shellName: string;
			command: string;
			exitCode: number | null;
			output: string;
			cwd: string | null;
			durationMs: number;
	  }
	/** The tab was closed, or its shell exited, before a command finished. */
	| { kind: 'closed'; shellName: string }
	/**
	 * The command is typed in and nothing waited: `wait` was false, or the
	 * shell doesn't report when a command finishes (`integration: false`).
	 */
	| { kind: 'opened'; shellName: string; integration: boolean }
	/** The signal fired while waiting. */
	| { kind: 'aborted'; shellName: string }
	/** No shell could be opened; `message` says why. */
	| { kind: 'unavailable'; message: string };

export type ShellCommandOpener = (req: ShellCommandRequest) => Promise<ShellCommandResult>;

let opener: ShellCommandOpener | null = null;
/**
 * A detached Code window has no Shell tab of its own (the shell store loads
 * there too, but nothing renders it): it sends the request to the main
 * window instead (`code/shellRelay.ts`). Takes precedence over `opener`.
 */
let relay: ShellCommandOpener | null = null;

/** Called by the shell store when it loads. Returns the unregister. */
export function registerShellCommandOpener(fn: ShellCommandOpener): () => void {
	opener = fn;
	return () => {
		if (opener === fn) opener = null;
	};
}

/** Called by a detached Code window. Returns the unregister. */
export function useShellRelay(fn: ShellCommandOpener): () => void {
	relay = fn;
	return () => {
		if (relay === fn) relay = null;
	};
}

export function hasShellCommandOpener(): boolean {
	return (relay ?? opener) !== null;
}

/** Open a Shell tab with `command` typed in. See `ShellCommandRequest`. */
export async function openShellForCommand(req: ShellCommandRequest): Promise<ShellCommandResult> {
	const open = relay ?? opener;
	if (!open) return { kind: 'unavailable', message: 'The Shell tab is not available here.' };
	return open(req);
}

// --- the wait, as the Code session shows it ---------------------------------

export interface ShellWait {
	shellName: string;
	command: string;
	/** Show the shell tab. */
	focus: () => void;
	/** Stop waiting; the turn goes on without the result. */
	cancel: () => void;
}

type WaitListener = (wait: ShellWait | null) => void;

const waitListeners = new Map<string, WaitListener>();

/** A Code session follows its own waits. Returns the unsubscribe. */
export function setShellWaitListener(codeSessionId: string, fn: WaitListener): () => void {
	waitListeners.set(codeSessionId, fn);
	return () => {
		if (waitListeners.get(codeSessionId) === fn) waitListeners.delete(codeSessionId);
	};
}

/** The tool started (`wait`) or finished (null) waiting on a shell. */
export function reportShellWait(codeSessionId: string, wait: ShellWait | null): void {
	waitListeners.get(codeSessionId)?.(wait);
}
