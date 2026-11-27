/**
 * A clip a video model refuses before anything reaches its server goes to
 * the next model that can make it, refitted to that model's size and length.
 * Routing passes over a model that doesn't answer, but only a backend sees the
 * whole request, so only it can refuse a clip over its cost limit, a picture
 * it can't take, or a model OpenRouter has no endpoint left for.
 *
 * Never once the job was handed over (`onHandle`): it may be made and paid
 * for already. Never for a model the chat model named: that one alone may
 * make it.
 */

import { errMessage } from '#lib/utils/error.ts';
import { fitClip } from '#lib/videogen/fit.ts';
import { needOf, passOver, routeVideo, type Routed } from '#lib/videogen/route.ts';
import type { VideoBackend } from '#lib/videogen/backend.ts';
import type {
	VideoGenerateOptions,
	VideoModelEntry,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';

/**
 * A failure that says which video model it came from ("Wan 2.2 14B: …"), so
 * the model reading the notice knows what to try instead. The error keeps its
 * class, kind and status, which the task runner reads; a cancel is left alone.
 */
export function namedFailure(e: unknown, model: string, signal?: AbortSignal): unknown {
	if (signal?.aborted || (e as { kind?: unknown } | null)?.kind === 'cancelled') return e;
	if (!(e instanceof Error)) return new Error(`${model}: ${errMessage(e)}`);
	if (!e.message.startsWith(`${model}:`)) e.message = `${model}: ${e.message}`;
	return e;
}

/** `request` as `to` would make it: the same length and shape, at its size and frame rate. */
export function refitFor(
	request: VideoRequest,
	to: Routed
): { request: VideoRequest; note: string | null } {
	const seconds = request.fps > 0 ? (request.frames - 1) / request.fps : undefined;
	const fit = fitClip(
		to.caps.limits,
		to.entry.name,
		{ seconds, portrait: request.height > request.width },
		to.caps.frameStep
	);
	return {
		request: { ...request, width: fit.width, height: fit.height, frames: fit.frames, fps: fit.fps },
		note: fit.note
	};
}

export interface PassedOn {
	made: VideoResult;
	/** The model that made it. */
	entry: VideoModelEntry;
	/** What was passed on, and why: empty when the first model made it. */
	notes: string[];
}

/**
 * Make `request` on `first`, or on the next model that can when `first`
 * refuses it before sending. A failure is named after the model that failed.
 */
export async function generatePassingOn(
	first: { entry: VideoModelEntry; backend: VideoBackend },
	request: VideoRequest,
	opts: VideoGenerateOptions,
	how: { named?: boolean; sound?: boolean } = {}
): Promise<PassedOn> {
	let { entry, backend } = first;
	let asked = request;
	const notes: string[] = [];
	const tried = [entry.id];
	for (;;) {
		let handedOver = false;
		const onHandle: VideoGenerateOptions['onHandle'] = (h) => {
			handedOver = true;
			opts.onHandle?.(h);
		};
		try {
			return { made: await backend.generate(asked, { ...opts, onHandle }), entry, notes };
		} catch (e) {
			const next =
				handedOver || how.named || opts.signal?.aborted || !passOver(e)
					? null
					: await routeVideo(needOf(asked, how.sound), {
							skip: [...tried],
							signal: opts.signal
						}).catch(() => null);
			if (!next) throw namedFailure(e, entry.name, opts.signal);
			tried.push(next.entry.id);
			const refit = refitFor(asked, next);
			notes.push(
				`${entry.name} couldn't make it (${errMessage(e).replace(/\.$/, '')}), so ${next.entry.name} did.`,
				...(refit.note ? [refit.note] : [])
			);
			({ entry, backend } = next);
			asked = refit.request;
		}
	}
}
