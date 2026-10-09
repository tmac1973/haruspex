/**
 * `open_in_shell` from a detached Code window.
 *
 * Shell tabs live in the main window, and so does the opener that makes them
 * (`shellBridge.registerShellCommandOpener`). A detached Code window
 * installs `createShellRelay` as its opener instead: each request goes to
 * the main window as an event, which opens the Shell tab there, brings the
 * window to the front, and sends back the tab's name (`opened`) and, once
 * the user has run the command, the result. "Go to shell" and the wait's
 * Cancel (or the turn's Stop) travel the same way.
 *
 *   detached                    main
 *   shell-open   ────────────▶  accepted, then opened { name }, then result
 *   shell-focus  ────────────▶  show the tab, raise the window
 *   shell-abort  ────────────▶  end the wait (the tab stays open)
 *
 * The transport is injected (`RelayBus`), so both ends can be tested
 * against each other without Tauri.
 */
import type { ShellCommandOpener, ShellCommandResult } from '#lib/code/shellBridge.ts';
import { errMessage } from '#lib/utils/error.ts';

export const SHELL_OPEN_EVENT = 'code://shell-open';
export const SHELL_ACCEPTED_EVENT = 'code://shell-accepted';
export const SHELL_OPENED_EVENT = 'code://shell-opened';
export const SHELL_RESULT_EVENT = 'code://shell-result';
export const SHELL_FOCUS_EVENT = 'code://shell-focus';
export const SHELL_ABORT_EVENT = 'code://shell-abort';

export interface RelayBus {
	emitTo(label: string, event: string, payload: unknown): Promise<void>;
	/** Resolves once listening; the returned function stops it. */
	listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
}

interface OpenMsg {
	reqId: string;
	/** The window to answer. */
	from: string;
	command: string;
	cwd: string;
	wait: boolean;
}
interface IdMsg {
	reqId: string;
}
interface OpenedMsg extends IdMsg {
	name: string;
}
interface ResultMsg extends IdMsg {
	result: ShellCommandResult;
}

/** How long the main window gets to say it heard a request. */
export const ACK_TIMEOUT_MS = 5000;

/** The detached window's opener: every request goes to `main`. */
export function createShellRelay(
	bus: RelayBus,
	self: string,
	opts: { main?: string; ackTimeoutMs?: number } = {}
): ShellCommandOpener {
	const main = opts.main ?? 'main';
	const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
	const pending = new Map<
		string,
		{
			accepted: () => void;
			opened: (name: string) => void;
			finish: (r: ShellCommandResult) => void;
		}
	>();
	let seq = 0;
	let listening: Promise<void> | null = null;
	const listenOnce = () =>
		(listening ??= Promise.all([
			bus.listen<IdMsg>(SHELL_ACCEPTED_EVENT, (p) => pending.get(p.reqId)?.accepted()),
			bus.listen<OpenedMsg>(SHELL_OPENED_EVENT, (p) => pending.get(p.reqId)?.opened(p.name)),
			bus.listen<ResultMsg>(SHELL_RESULT_EVENT, (p) => pending.get(p.reqId)?.finish(p.result))
		]).then(() => {}));

	return async (req) => {
		// Listening before asking, or a fast answer is lost.
		await listenOnce();
		const reqId = `${self}:${++seq}`;
		return new Promise<ShellCommandResult>((resolve) => {
			let shellName = '';
			const timer = setTimeout(
				() =>
					finish({
						kind: 'unavailable',
						message: 'The main window did not answer, so no Shell tab was opened.'
					}),
				ackTimeoutMs
			);
			const onAbort = () => {
				void bus.emitTo(main, SHELL_ABORT_EVENT, { reqId } satisfies IdMsg).catch(() => {});
				finish({ kind: 'aborted', shellName });
			};
			function finish(result: ShellCommandResult) {
				if (!pending.delete(reqId)) return;
				clearTimeout(timer);
				req.signal?.removeEventListener('abort', onAbort);
				resolve(result);
			}
			pending.set(reqId, {
				accepted: () => clearTimeout(timer),
				opened: (name) => {
					shellName = name;
					req.onOpened?.({
						name,
						focus: () =>
							void bus.emitTo(main, SHELL_FOCUS_EVENT, { reqId } satisfies IdMsg).catch(() => {})
					});
				},
				finish
			});
			if (req.signal?.aborted) {
				finish({ kind: 'aborted', shellName });
				return;
			}
			req.signal?.addEventListener('abort', onAbort, { once: true });
			bus
				.emitTo(main, SHELL_OPEN_EVENT, {
					reqId,
					from: self,
					command: req.command,
					cwd: req.cwd,
					wait: req.wait
				} satisfies OpenMsg)
				.catch((e: unknown) =>
					finish({
						kind: 'unavailable',
						message: `The main window could not be reached: ${errMessage(e)}`
					})
				);
		});
	};
}

/**
 * The main window's side: answer detached windows' requests with `open`
 * (the real Shell-tab opener). `raise` brings the main window to the front.
 * Resolves once listening, to the function that stops it.
 */
export async function serveShellRelay(
	bus: RelayBus,
	open: ShellCommandOpener,
	raise: () => void
): Promise<() => void> {
	const live = new Map<string, { abort: AbortController; focus: (() => void) | null }>();
	/** Aborts that arrived before their request did. */
	const early = new Set<string>();

	async function handle(p: OpenMsg): Promise<void> {
		if (live.has(p.reqId)) return;
		void bus.emitTo(p.from, SHELL_ACCEPTED_EVENT, { reqId: p.reqId } satisfies IdMsg);
		if (early.delete(p.reqId)) {
			await bus
				.emitTo(p.from, SHELL_RESULT_EVENT, {
					reqId: p.reqId,
					result: { kind: 'aborted', shellName: '' }
				} satisfies ResultMsg)
				.catch(() => {});
			return;
		}
		const entry = { abort: new AbortController(), focus: null as (() => void) | null };
		live.set(p.reqId, entry);
		raise();
		let result: ShellCommandResult;
		try {
			result = await open({
				command: p.command,
				cwd: p.cwd,
				wait: p.wait,
				signal: entry.abort.signal,
				onOpened: (shell) => {
					entry.focus = shell.focus;
					void bus
						.emitTo(p.from, SHELL_OPENED_EVENT, {
							reqId: p.reqId,
							name: shell.name
						} satisfies OpenedMsg)
						.catch(() => {});
				}
			});
		} catch (e) {
			result = { kind: 'unavailable', message: errMessage(e) };
		} finally {
			live.delete(p.reqId);
		}
		await bus
			.emitTo(p.from, SHELL_RESULT_EVENT, { reqId: p.reqId, result } satisfies ResultMsg)
			.catch(() => {});
	}

	const stops = await Promise.all([
		bus.listen<OpenMsg>(SHELL_OPEN_EVENT, (p) => void handle(p)),
		bus.listen<IdMsg>(SHELL_FOCUS_EVENT, (p) => {
			const entry = live.get(p.reqId);
			if (!entry?.focus) return;
			entry.focus();
			raise();
		}),
		bus.listen<IdMsg>(SHELL_ABORT_EVENT, (p) => {
			const entry = live.get(p.reqId);
			if (entry) entry.abort.abort();
			else early.add(p.reqId);
		})
	]);
	return () => stops.forEach((stop) => stop());
}
