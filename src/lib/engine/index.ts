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
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';
import { dispatch, setResync } from './dispatch.ts';
import { watchPrompts } from './prompts.svelte.ts';
import type { EngineEvent, EngineOp } from './types.ts';
import { watchOpenSessions } from './watch.svelte.ts';

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

/**
 * Start this window's engine, now if Rust has it on, else when it is switched
 * on (the owner API starting: `engine://enabled`), so turning Settings →
 * Remote control on needs no restart. Switching off leaves it running: Rust
 * drops what it sends while off, and it costs a few watchers.
 */
export async function startEngine(): Promise<void> {
	const label = getCurrentWindow().label;
	if (!isEngineWindow(label)) return;
	// Listening before asking, so a switch-on between the two isn't missed.
	const stop = await listen<boolean>('engine://enabled', ({ payload }) => {
		if (payload) void run(label).then(stop);
	});
	if (await invoke<boolean>('engine_enabled').catch(() => false)) {
		stop();
		await run(label);
	}
}

async function run(label: string): Promise<void> {
	if (started) return;
	started = true;

	const sink = batcher((events) => {
		invoke('engine_events', { events }).catch((e: unknown) => {
			logDebug('engine', 'sending events failed', { error: errMessage(e) });
		});
	});
	setResync(watchOpenSessions(sink).resync);
	watchPrompts(label, sink);

	await listen<{ reqId: string; op: EngineOp; window: string }>(
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
	logDebug('engine', 'started', { window: label });
}
