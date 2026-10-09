/**
 * Turn what a Code session does into events, by watching its public state.
 * The session never calls in here; the desktop UI and the engine read the
 * same `$state`, which is what keeps them from disagreeing.
 *
 * - The thread (`messages` and the maps keyed by message) only changes as a
 *   turn opens and as it commits; either sends a whole `snapshot`.
 * - `live` text is coalesced to one event per `LIVE_MS`, and flushed before
 *   any other event, so a client never sees a step or a status ahead of the
 *   text that came before it.
 */
import { untrack } from 'svelte';
import { getOpenSessions, type CodeSession } from '#lib/stores/code.svelte.ts';
import { metaState, sessionState, stepsState } from './state.ts';
import type { SessionEvent } from './types.ts';

export const LIVE_MS = 50;

type Body = SessionEvent extends infer E
	? E extends unknown
		? Omit<E, 'seq' | 'sessionId'>
		: never
	: never;

export interface SessionWatch {
	/** Send a fresh snapshot (a client asked to resync). */
	snapshot: () => void;
	/** Say the session is gone here, then stop. */
	close: () => void;
	stop: () => void;
}

export function watchSession(s: CodeSession, sink: (e: SessionEvent) => void): SessionWatch {
	let seq = 0;
	let liveTimer: ReturnType<typeof setTimeout> | null = null;

	const send = (body: Body) => sink({ ...body, seq: ++seq, sessionId: s.id } as SessionEvent);
	const flushLive = () => {
		if (liveTimer === null) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		send({ type: 'live', streamingContent: s.streamingContent, roundText: s.roundText });
	};
	const emit = (body: Body) => {
		flushLive();
		send(body);
	};
	const snapshot = () => emit({ type: 'snapshot', state: sessionState(s) });

	// What the first snapshot said, taken now: an effect's first run comes at
	// the next flush, by which time the session may already have moved on.
	const threadRefs = () => [s.messages, s.messageSteps, s.messageStats, s.messageStops];
	let lastThread = threadRefs();
	let lastStatus = s.status;
	let lastLive = [s.streamingContent, s.roundText];
	let lastSteps = JSON.stringify(stepsState(s.searchSteps));
	let lastMeta = JSON.stringify(metaState(s));
	snapshot();

	const stopEffects = $effect.root(() => {
		$effect(() => {
			// Reassigned, never mutated, as a turn opens and as it commits.
			const refs = threadRefs();
			if (refs.every((r, i) => r === lastThread[i])) return;
			lastThread = refs;
			untrack(snapshot);
		});

		$effect(() => {
			const status = s.status;
			const busy = s.busy;
			if (status === lastStatus) return;
			lastStatus = status;
			untrack(() => emit({ type: 'status', status, busy }));
		});

		$effect(() => {
			const live = [s.streamingContent, s.roundText];
			if (live[0] === lastLive[0] && live[1] === lastLive[1]) return;
			lastLive = live;
			untrack(() => {
				liveTimer ??= setTimeout(() => {
					liveTimer = null;
					send({ type: 'live', streamingContent: s.streamingContent, roundText: s.roundText });
				}, LIVE_MS);
			});
		});

		$effect(() => {
			const steps = stepsState(s.searchSteps);
			const key = JSON.stringify(steps);
			if (key === lastSteps) return;
			lastSteps = key;
			untrack(() => emit({ type: 'steps', searchSteps: steps }));
		});

		$effect(() => {
			const meta = metaState(s);
			const key = JSON.stringify(meta);
			if (key === lastMeta) return;
			lastMeta = key;
			untrack(() => emit({ type: 'meta', meta }));
		});
	});

	const stop = () => {
		stopEffects();
		if (liveTimer !== null) clearTimeout(liveTimer);
		liveTimer = null;
	};
	return {
		snapshot,
		close: () => {
			stop();
			send({ type: 'closed' });
		},
		stop
	};
}

/** Watch every session open in this window, as they open and close. */
export function watchOpenSessions(sink: (e: SessionEvent) => void): {
	stop: () => void;
	resync: (id: string) => boolean;
} {
	// Which sessions are watched; never rendered, so not a SvelteMap.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const watches = new Map<string, SessionWatch>();
	const stopRoot = $effect.root(() => {
		$effect(() => {
			const open = [...getOpenSessions()];
			untrack(() => {
				for (const s of open) {
					if (!watches.has(s.id)) watches.set(s.id, watchSession(s, sink));
				}
				for (const [id, w] of watches) {
					if (open.some((s) => s.id === id)) continue;
					w.close();
					watches.delete(id);
				}
			});
		});
	});
	return {
		stop: () => {
			stopRoot();
			for (const w of watches.values()) w.stop();
			watches.clear();
		},
		resync: (id) => {
			const w = watches.get(id);
			w?.snapshot();
			return !!w;
		}
	};
}
