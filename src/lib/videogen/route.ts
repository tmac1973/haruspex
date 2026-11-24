/**
 * Which saved video model makes a clip: the one the call names, or else the
 * first, in the user's order, that can do what the request needs (start or
 * end on a picture, make someone speak, have its own sound). A model that
 * doesn't answer is passed over for the next; one that can't do the job is
 * never asked to.
 *
 * Capabilities come from what each entry keeps; the one chosen is probed
 * before it runs, and what it says then is kept.
 */

import { videoBackendForEntry } from '#lib/videogen/index.ts';
import { saveVideoCaps, videoEntries, videoEntryByName } from '#lib/videogen/entries.ts';
import type { VideoBackend } from '#lib/videogen/backend.ts';
import { VideoBackendError } from '#lib/videogen/backend.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { VideoCaps, VideoModelEntry, VideoRequest } from '#lib/videogen/types.ts';

/** What a request asks of a video model. */
export interface VideoNeed {
	/** No start image: the clip comes from the prompt alone. */
	text: boolean;
	startImage: boolean;
	endImage: boolean;
	speech: boolean;
	sound: boolean;
}

export const NOT_SET_UP =
	'Video generation is not set up. The user can add a video model in Settings → Video generation.';

const SECTION = 'Settings → Video generation';

/** What `req` needs; `sound` comes from the call, since a request doesn't say. */
export function needOf(req: VideoRequest, sound = false): VideoNeed {
	return {
		text: !req.startImage,
		startImage: !!req.startImage,
		endImage: !!req.endImage,
		speech: !!req.audio,
		sound
	};
}

/** Each thing a need may ask, and how a sentence says a model can't. */
const PARTS: [keyof VideoNeed & keyof VideoCaps, string][] = [
	['text', 'make a clip from the prompt alone'],
	['startImage', 'start from a picture'],
	['endImage', 'end on a picture'],
	['speech', 'make someone speak'],
	['sound', 'make a clip with sound']
];

/** What `caps` can't do of `need`, as phrases; none when it can do it all. */
export function cantDo(caps: VideoCaps, need: VideoNeed): string[] {
	const missing = PARTS.filter(([k]) => need[k] && !caps[k]).map(([, say]) => say);
	// A speaking model makes a person in a picture say something, so it needs both.
	if (need.speech && caps.speech && !caps.startImage) missing.push('start from a picture');
	if (caps.needsSpeech && !need.speech) missing.push('make a clip without speech');
	return missing;
}

export function meetsNeed(caps: VideoCaps, need: VideoNeed): boolean {
	return cantDo(caps, need).length === 0;
}

/** `e` and its server, for a sentence that lists several. */
function place(e: VideoModelEntry): string {
	return e.url.trim() ? `${e.name} (${hostOf(e.url)})` : e.name;
}

/** "can't X or Y". */
function cant(missing: string[]): string {
	return `can't ${missing.join(' or ')}`;
}

/** Why every model in `known` can't do `need`: the one thing none can, else that none does it all. */
function noneCanSay(need: VideoNeed, known: { entry: VideoModelEntry; caps: VideoCaps }[]): string {
	const each = known.map((k) => cantDo(k.caps, need));
	const asked = [...new Set(each.flat())];
	const nobody = asked.filter((m) => each.every((list) => list.includes(m)));
	if (nobody.length > 0) {
		return `None of the video models in ${SECTION} can ${nobody[0]}.`;
	}
	return `None of the video models in ${SECTION} can do all of that in one clip: ${known
		.map((k, i) => `${k.entry.name} ${cant(each[i])}`)
		.join('; ')}.`;
}

/** An error that means "try the next model": the server is away, or the model isn't there. */
function passOver(e: unknown): boolean {
	return e instanceof VideoBackendError && (e.kind === 'unreachable' || e.kind === 'unconfigured');
}

/** A model that answered and can't do the job. */
class CannotDo extends Error {
	constructor(
		readonly caps: VideoCaps,
		readonly missing: string[]
	) {
		super('cannot do it');
	}
}

/** `entry`'s backend, probed and asked what it can do (kept), or why not. */
export async function readyEntry(
	entry: VideoModelEntry,
	signal?: AbortSignal
): Promise<{ backend: VideoBackend; caps: VideoCaps }> {
	const backend = videoBackendForEntry(entry);
	if (!backend) {
		throw new VideoBackendError('unconfigured', `${entry.name} is not a kind this build can use.`);
	}
	const probed = await backend.probe(signal);
	if (!probed.ok) throw new VideoBackendError('unreachable', probed.detail);
	const caps = await backend.capabilities(signal);
	saveVideoCaps(entry.id, caps);
	return { backend, caps };
}

export interface Routed {
	entry: VideoModelEntry;
	backend: VideoBackend;
	caps: VideoCaps;
}

/**
 * The entries worth asking, in order: `prefer` first, then those known to be
 * able, then those no probe has answered for. Known unable ones are left out.
 */
function candidates(need: VideoNeed, prefer?: VideoModelEntry): VideoModelEntry[] {
	const list = videoEntries();
	const able = list.filter((e) => e.caps && meetsNeed(e.caps, need));
	const unknown = list.filter((e) => !e.caps);
	const order = [...able, ...unknown];
	if (!prefer) return order;
	return [prefer, ...order.filter((e) => e.id !== prefer.id)];
}

/** The model `name` names, ready and able, or why not (naming those that can). */
async function routeNamed(name: string, need: VideoNeed, signal?: AbortSignal): Promise<Routed> {
	const entry = videoEntryByName(name);
	if (!entry) {
		const names = videoEntries().map((e) => e.name);
		throw new VideoBackendError(
			'rejected',
			`There is no video model called ${name}. The models are: ${names.join(', ')}.`
		);
	}
	const ready = await readyEntry(entry, signal);
	const missing = cantDo(ready.caps, need);
	if (missing.length > 0) {
		const others = videoEntries()
			.filter((e) => e.id !== entry.id && e.caps && meetsNeed(e.caps, need))
			.map((e) => e.name);
		const can = others.length ? ` ${others.join(', ')} can.` : '';
		throw new VideoBackendError('rejected', `${entry.name} ${cant(missing)}.${can}`);
	}
	return { entry, ...ready };
}

/**
 * The model that makes a clip needing `need`: `named`, or the first that can.
 * Throws the not-set-up sentence for an empty list, what's missing when every
 * model answered and none can, or each model's reason otherwise.
 */
export async function routeVideo(
	need: VideoNeed,
	opts: { named?: string; prefer?: VideoModelEntry; signal?: AbortSignal } = {}
): Promise<Routed> {
	if (videoEntries().length === 0) throw new VideoBackendError('unconfigured', NOT_SET_UP);
	if (opts.named) return routeNamed(opts.named, need, opts.signal);
	const reasons: { entry: VideoModelEntry; reason: string }[] = [];
	const unable: { entry: VideoModelEntry; caps: VideoCaps }[] = [];
	for (const entry of candidates(need, opts.prefer)) {
		try {
			const ready = await readyEntry(entry, opts.signal);
			const missing = cantDo(ready.caps, need);
			if (missing.length > 0) throw new CannotDo(ready.caps, missing);
			return { entry, ...ready };
		} catch (e) {
			if (e instanceof CannotDo) {
				unable.push({ entry, caps: e.caps });
				reasons.push({ entry, reason: cant(e.missing) });
				continue;
			}
			if (!passOver(e)) throw e;
			reasons.push({ entry, reason: errMessage(e).replace(/\.$/, '') });
		}
	}
	// Known unable ones were never asked; they still say why.
	for (const entry of videoEntries()) {
		if (
			entry.caps &&
			!meetsNeed(entry.caps, need) &&
			!reasons.some((r) => r.entry.id === entry.id)
		) {
			unable.push({ entry, caps: entry.caps });
			reasons.push({ entry, reason: cant(cantDo(entry.caps, need)) });
		}
	}
	if (unable.length === videoEntries().length) {
		throw new VideoBackendError('rejected', noneCanSay(need, unable));
	}
	throw new VideoBackendError(
		'unreachable',
		`No video model could make it: ${reasons.map((r) => `${place(r.entry)}: ${r.reason}`).join('; ')}.`
	);
}
