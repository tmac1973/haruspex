/**
 * A Code session's background subtasks: `delegate` calls with
 * `background: true`, which outlive the turn that started them.
 *
 * Each takes an inference slot of its own (never the turn's lender, since it
 * runs on after the turn lets go), so on a serialized lane it simply waits for
 * the turn to end. At most `BACKGROUND_SUBTASKS_RUNNING` run at once per
 * session; the rest wait their turn. Each one's stop is in the session's
 * `SubtaskStops`, marked as background, so the session's Stop leaves it be.
 * When one ends the session hears of it (`onDone`) and delivers its report
 * in a notification turn.
 */
import { withInferenceSlot } from '#lib/agent/inferenceQueue.svelte.ts';
import type { BackendOverride } from '#lib/api.ts';
import type { CodeWriteGuard, SlotLender } from '#lib/agent/tools/types.ts';
import { finishedSubtask, type SubtaskState, type SubtaskStops } from '#lib/code/subtask.ts';
import { discardQuietly } from '#lib/code/subtaskApply.ts';
import { runSubtaskSpec, type SubtaskEnv, type SubtaskSpec } from '#lib/code/subtaskRun.ts';
import { logDebug } from '#lib/debug-log.ts';
import { errMessage } from '#lib/utils/error.ts';

/** The most background subtasks one session runs at once. */
export const BACKGROUND_SUBTASKS_RUNNING = 4;

/** A background subtask that has ended, for the notification turn. */
export interface CompletedSubtask {
	id: string;
	label: string;
	/** What the parent is told, as a blocking call's result would say it. */
	text: string;
}

/** The session's side of its background subtasks. */
export interface BackgroundSubtaskHost {
	/** Where they run, as the session is now. */
	place(): {
		sessionId: string;
		folder: string;
		wslDistro: string | null;
		backend: BackendOverride | null;
		effort: string | null;
		requester: () => string;
	};
	/**
	 * The session's write lease for one apply, and `done` to call after it:
	 * a running turn's own guard, or one that gives the folder back.
	 */
	lease(): { guard: CodeWriteGuard; done: () => Promise<void> };
	stops: SubtaskStops;
	/** A card changed. */
	onState(state: SubtaskState): void;
	/** One ended. */
	onDone(done: CompletedSubtask): void;
}

interface Pending {
	spec: SubtaskSpec;
	initial: SubtaskState;
	controller: AbortController;
}

export class BackgroundSubtasks {
	private readonly waiting: Pending[] = [];
	private readonly running = new Map<string, Promise<void>>();

	constructor(private readonly host: BackgroundSubtaskHost) {}

	/** Start `spec` now, or once one of the running ones ends. */
	start(spec: SubtaskSpec, initial: SubtaskState): void {
		const controller = new AbortController();
		this.host.stops.register(spec.id, controller, { background: true });
		this.waiting.push({ spec, initial, controller });
		this.pump();
	}

	/** How many are running or waiting to. */
	get active(): number {
		return this.running.size + this.waiting.length;
	}

	/** Resolves once every running one has ended (after `stopAll`, soon). */
	async settle(): Promise<void> {
		while (this.running.size > 0) await Promise.all(this.running.values());
	}

	private pump(): void {
		while (this.running.size < BACKGROUND_SUBTASKS_RUNNING && this.waiting.length > 0) {
			const next = this.waiting.shift() as Pending;
			const run = this.run(next).then((done) => {
				this.running.delete(next.spec.id);
				this.host.stops.delete(next.spec.id);
				// After it's gone from the count, so the session sees it ended.
				if (done) this.host.onDone(done);
				this.pump();
			});
			this.running.set(next.spec.id, run);
		}
	}

	/** Run one to the end: what to report, or null when there is nothing to. Never throws. */
	private async run({ spec, initial, controller }: Pending): Promise<CompletedSubtask | null> {
		const signal = controller.signal;
		// Stopped while it waited its turn: it never starts.
		if (signal.aborted) {
			if (spec.wt) await discardQuietly(spec.wt, this.host.place().wslDistro);
			this.host.onState(finishedSubtask(initial, { status: 'stopped', report: '', steps: [] }));
			return {
				id: spec.id,
				label: spec.label,
				text: `Subtask "${spec.label}" (stopped, 0 tool calls): the user stopped it before it started; do not start it again.`
			};
		}
		const place = this.host.place();
		// The lease is asked for only when a writer has changes to apply.
		let lease: ReturnType<BackgroundSubtaskHost['lease']> | null = null;
		const guard: CodeWriteGuard = {
			acquire: () => (lease ??= this.host.lease()).guard.acquire(),
			changed: (paths) => lease?.guard.changed(paths)
		};
		const ownSlot: SlotLender = (fn, opts) =>
			withInferenceSlot(
				{
					consumer: 'subagent',
					backend: place.backend ?? undefined,
					signal: opts?.signal ?? signal,
					onAdmitted: opts?.onAdmitted
				},
				fn
			);
		const env: SubtaskEnv = {
			...place,
			runInSlot: ownSlot,
			guard,
			signal,
			// Nothing but its card's stop, or closing the session, stops it.
			stoppedByUser: () => signal.aborted,
			onState: (s) => this.host.onState(s)
		};
		try {
			const res = await runSubtaskSpec(spec, env, initial);
			return { id: spec.id, label: spec.label, text: res.text };
		} catch (e) {
			logDebug('code', 'background subtask threw', { id: spec.id, error: errMessage(e) });
			return null;
		} finally {
			if (lease) await (lease as { done: () => Promise<void> }).done();
		}
	}
}

/** The fixed opening of a notification turn for finished background subtasks. */
export function subtaskNotificationHead(count: number): string {
	return count === 1
		? 'A subtask you started in the background has finished.'
		: `${count} subtasks you started in the background have finished.`;
}

/** The notification turn's text for `done`. */
export function buildSubtaskNotification(done: CompletedSubtask[]): string {
	return [subtaskNotificationHead(done.length), ...done.map((d) => `\n${d.text}`)].join('\n');
}

/**
 * Whether a user-role message is a subtask notification, not something the
 * user typed. Matched on the fixed opening line, so saved threads work too.
 */
export function isSubtaskNotification(text: string): boolean {
	return /^(A subtask you started in the background has finished\.|\d+ subtasks you started in the background have finished\.)/.test(
		text
	);
}
