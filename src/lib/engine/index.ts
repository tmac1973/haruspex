/**
 * The engine surface for Code sessions (plan/remote-api/phase-02): how a
 * client other than this window's own UI acts on its sessions and follows
 * them. Started in every window from the root layout; it only runs in the
 * main and detached Code windows, and only while Rust has it on (the e2e
 * build, until the owner API lands).
 *
 * Rust sends operations as `engine://op` events and takes the answer through
 * `engine_reply`; events go up in batches through `engine_events`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import { dispatch, MAIN_WINDOW, setChatResync, setResync } from '#lib/engine/dispatch.ts';
import { watchPrompts } from '#lib/engine/prompts.svelte.ts';
import type { EngineEvent, EngineOp } from '#lib/engine/types.ts';
import { watchOpenSessions } from '#lib/engine/watch.svelte.ts';

const BATCH_MS = 20;

export function isEngineWindow(label: string): boolean {
	return label === 'main' || label.startsWith('code-');
}

/** Collect events and send them up together. A timer, not a frame: frames stop in a hidden window. */
export function batcher(send: (events: EngineEvent[]) => void): (e: EngineEvent) => void {
	let batch: EngineEvent[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (e) => {
		batch.push(e);
		timer ??= setTimeout(() => {
			const out = batch;
			batch = [];
			timer = null;
			send(out);
		}, BATCH_MS);
	};
}

let started = false;

/** What `run` started, the op listener and the watchers, for `stopEngine`. */
const teardown: Array<() => void> = [];

/** Stop listening for ops and stop the watchers, so a fresh start is the only one. */
export function stopEngine(): void {
	for (const undo of teardown.splice(0)) undo();
	started = false;
}

/**
 * The engine running in this window, whichever copy of this module started
 * it. A dev build's hot reload runs this module again without disposing the
 * old copy (Vite disposes only the module that accepts the update), and the
 * old copy's listener kept answering ops from the old chat store, which
 * didn't know a chat made since: its fast "no chat" beat the real answer.
 * So a starting engine stops the one before it.
 */
const RUNNING = '__haruspexEngineStop';
type WithEngine = typeof globalThis & { [RUNNING]?: () => void };

/**
 * Start this window's engine, now if Rust has it on, else when it is switched
 * on (the owner API starting: `engine://enabled`), so turning Settings →
 * Remote control on needs no restart. Switching off leaves it running: Rust
 * drops what it sends while off, and it costs a few watchers.
 */
export async function startEngine(): Promise<void> {
	const label = getCurrentWindow().label;
	if (!isEngineWindow(label)) return;
	// Listening before asking, so a switch-on between the two isn't missed. A
	// switch-on can arrive before `listen` resolves, while there is nothing to
	// unlisten yet: it starts the engine, and the listener goes once it's known.
	let unlisten: (() => void) | null = null;
	let done = false;
	const stop = () => {
		if (done || !unlisten) return;
		done = true;
		unlisten();
	};
	unlisten = await listen<boolean>('engine://enabled', ({ payload }) => {
		if (payload) void run(label).then(stop);
	});
	if (started) {
		stop();
		return;
	}
	if (await invoke<boolean>('engine_enabled').catch(() => false)) {
		stop();
		await run(label);
	}
}

async function run(label: string): Promise<void> {
	if (started) return;
	started = true;
	const g = globalThis as WithEngine;
	g[RUNNING]?.();
	g[RUNNING] = stopEngine;

	const sink = batcher((events) => {
		void invoke('engine_events', { events }).catch((e: unknown) => {
			logDebug('engine', 'sending events failed', { error: errMessage(e) });
		});
	});
	const sessions = watchOpenSessions(sink);
	setResync(sessions.resync);
	const keep = (undo: (() => void) | undefined) => {
		if (undo) teardown.push(undo);
	};
	keep(sessions.stop);
	keep(watchPrompts(label, sink));
	if (label === MAIN_WINDOW) {
		// Chat lives in the main window; loaded here only, not in Code windows.
		const { watchChats } = await import('#lib/engine/chat.svelte.ts');
		const chats = watchChats(sink);
		setChatResync(chats.resync);
		keep(chats.stop);
	}

	const unlistenOps = await listen<{ reqId: string; op: EngineOp; window: string }>(
		'engine://op',
		async ({ payload }) => {
			const { reqId, op, window } = payload;
			// Every window hears every op; only the one it was sent to answers.
			if (window !== label) return;
			let reply: { reqId: string; value?: unknown; error?: string };
			try {
				reply = { reqId, value: (await dispatch(op, label)) ?? null };
			} catch (e) {
				reply = { reqId, error: errMessage(e) };
			}
			await invoke('engine_reply', { reply }).catch(() => {});
		}
	);
	keep(unlistenOps);
	logDebug('engine', 'started', { window: label });
}
