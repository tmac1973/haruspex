/**
 * Which saved image model makes a picture: the first, in the user's order,
 * that can do what the request needs (draw, edit so many pictures, extend,
 * upscale), preferring one that can also do what it would only like
 * (transparency, tiling). An entry that doesn't answer is passed over for the
 * next that can do the job; a request one refuses is not tried elsewhere.
 *
 * Capabilities come from what each entry keeps (`#lib/image/entries.ts`);
 * the one chosen is probed before it runs, and what it says then is kept.
 */

import type { GenerateOptions, ImageBackend, ProbeResult } from '#lib/image/backend.ts';
import { backendForEntry } from '#lib/image/registry.ts';
import { imageEntries, saveImageCaps } from '#lib/image/entries.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { logDebug } from '#lib/debugLog.ts';
import { errMessage } from '#lib/utils/error.ts';
import {
	ImageBackendError,
	type ImageBackendCapabilities,
	type ImageModelEntry,
	type ImageRequest,
	type ImageResult
} from '#lib/image/types.ts';

export type ImageOp = 'draw' | 'edit' | 'extend' | 'upscale';

/** What a request asks of an image model. */
export interface ImageNeed {
	op: ImageOp;
	/** Pictures one edit combines. */
	pictures: number;
	/** Only a part may change. */
	mask: boolean;
	/** Wanted, not required: without it the picture comes back opaque, with a note. */
	transparent: boolean;
	/** Wanted, not required: without it the edges may not wrap. */
	seamless: boolean;
	loras: number;
}

export const NOT_SET_UP =
	'Image generation is not set up. The user can add an image model in Settings → Image.';

export const NO_EDIT_SENTENCE =
	"The image generation in Settings → Image can't edit pictures. Qwen-Image 2.1 can, on the " +
	'bundled engine or Lemonade (Settings → Image → Add editing) or ComfyUI 0.39 or later, and ' +
	'so can FLUX.2 klein 4B (on ComfyUI or llama-toolchest) and Qwen-Image-Edit-2511 (on ComfyUI).';

export const NO_EXTEND_SENTENCE =
	"The image generation in Settings → Image can't grow a picture past its edges. The bundled " +
	'engine and ComfyUI can, with any of their models.';

export const NO_UPSCALE_SENTENCE =
	"The image generation in Settings → Image can't upscale pictures. The bundled engine, " +
	'ComfyUI and Lemonade can, once their upscaler is installed in Settings → Image, and ' +
	'llama-toolchest can with an upscaler instance.';

/** What `req` needs. */
export function needOf(req: ImageRequest): ImageNeed {
	const op: ImageOp = req.inpaint ? 'extend' : req.edit ? 'edit' : 'draw';
	return {
		op,
		pictures: req.edit?.images.length ?? 0,
		mask: !!req.edit?.mask,
		transparent: !!req.transparent,
		seamless: !!req.seamless,
		loras: req.loras?.length ?? 0
	};
}

/** What an upscale needs. */
export function upscaleNeed(): ImageNeed {
	return { op: 'upscale', pictures: 0, mask: false, transparent: false, seamless: false, loras: 0 };
}

/** `caps` can do what `need` requires; what it only wants is not asked. */
export function meetsNeed(caps: ImageBackendCapabilities, need: ImageNeed): boolean {
	if (need.loras > (caps.loras ? caps.maxLoras : 0)) return false;
	switch (need.op) {
		case 'draw':
			return true;
		case 'edit':
			return !!caps.edit && (caps.maxEditImages ?? 1) >= need.pictures;
		case 'extend':
			return !!caps.inpaint;
		case 'upscale':
			return !!caps.upscale;
	}
}

function meetsWants(caps: ImageBackendCapabilities, need: ImageNeed): boolean {
	return (!need.transparent || caps.transparency) && (!need.seamless || caps.seamlessTiling);
}

/**
 * The entries that can do `need`, in the order to try them: those known to,
 * the ones that also do what it wants first; then those no probe has
 * answered for, which may.
 */
export function capableEntries(
	need: ImageNeed,
	entries: readonly ImageModelEntry[] = imageEntries()
): ImageModelEntry[] {
	const known = entries.filter((e) => e.caps && meetsNeed(e.caps, need));
	const unknown = entries.filter((e) => !e.caps);
	return [
		...known.filter((e) => meetsWants(e.caps!, need)),
		...known.filter((e) => !meetsWants(e.caps!, need)),
		...unknown
	];
}

/**
 * What the entry `need` would go to can do, as it keeps it, or as its
 * backend says when it keeps nothing yet; null when no entry can do it.
 */
export async function capabilitiesFor(need: ImageNeed): Promise<ImageBackendCapabilities | null> {
	const entry = capableEntries(need)[0];
	if (!entry) return null;
	if (entry.caps) return entry.caps;
	const backend = backendForEntry(entry);
	return backend ? backend.capabilities() : null;
}

/** "can't upscale pictures": what a model with `caps` lacks for `need`. */
function cannot(need: ImageNeed, caps: ImageBackendCapabilities): string {
	switch (need.op) {
		case 'edit':
			return caps.edit && need.pictures > 1
				? `can't combine ${need.pictures} pictures in one edit`
				: "can't edit pictures";
		case 'extend':
			return "can't grow a picture past its edges";
		case 'upscale':
			return "can't upscale pictures";
		default:
			return need.loras ? `can't take ${need.loras} LoRAs` : "can't draw this";
	}
}

/** Why no model with these capabilities can do `need`, as the model should hear it. */
function noneCanSay(need: ImageNeed, all: readonly (ImageBackendCapabilities | null)[]): string {
	if (need.op === 'upscale') return NO_UPSCALE_SENTENCE;
	if (need.op === 'extend') return NO_EXTEND_SENTENCE;
	if (need.op === 'edit') {
		const most = Math.max(0, ...all.filter((c) => c?.edit).map((c) => c!.maxEditImages ?? 1));
		if (most === 0) return NO_EDIT_SENTENCE;
		return `This model combines at most ${most} picture${most === 1 ? '' : 's'} in one edit.`;
	}
	return 'No image model in Settings → Image can draw this.';
}

/** What each entry keeps of its capabilities. */
function savedCaps(entries: readonly ImageModelEntry[]): (ImageBackendCapabilities | null)[] {
	return entries.map((e) => e.caps);
}

/** Where an entry is, for an error: its host, or this computer. */
function placeOf(e: ImageModelEntry): string {
	return e.url ? hostOf(e.url) : 'this computer';
}

/** A probed entry that turned out unable to do the job. */
class CannotDo extends ImageBackendError {
	constructor(
		entry: ImageModelEntry,
		need: ImageNeed,
		readonly caps: ImageBackendCapabilities
	) {
		super('unconfigured', `${entry.name} ${cannot(need, caps)}.`);
	}
}

/** Errors that say the entry can't be reached or isn't set up: try the next. */
function passOver(e: unknown): boolean {
	return e instanceof ImageBackendError && (e.kind === 'unreachable' || e.kind === 'unconfigured');
}

export interface RouteOptions {
	/** The entry the chat model named: it alone is tried. */
	named?: string;
	/** Tried first, even when no longer saved: the entry a background task started on. */
	prefer?: ImageModelEntry;
}

export interface Routed<T> {
	entry: ImageModelEntry;
	backend: ImageBackend;
	caps: ImageBackendCapabilities;
	value: T;
}

type Run<T> = (
	entry: ImageModelEntry,
	backend: ImageBackend,
	caps: ImageBackendCapabilities
) => Promise<T>;

/** `entry` probed and asked what it can do; throws why it can't be used now. */
async function ready(
	entry: ImageModelEntry,
	need: ImageNeed
): Promise<{ backend: ImageBackend; caps: ImageBackendCapabilities }> {
	const backend = backendForEntry(entry);
	if (!backend) {
		throw new ImageBackendError('unconfigured', `${entry.name}'s backend isn't in this build.`);
	}
	let probe: ProbeResult;
	try {
		probe = await backend.probe();
	} catch (e) {
		throw new ImageBackendError('unreachable', errMessage(e));
	}
	if (!probe.ok) throw new ImageBackendError('unreachable', probe.detail);
	const caps = await backend.capabilities();
	saveImageCaps(entry.id, caps);
	if (!meetsNeed(caps, need)) throw new CannotDo(entry, need, caps);
	return { backend, caps };
}

/** Run `need` on the entry the chat model named, or refuse saying who can. */
async function routeNamed<T>(name: string, need: ImageNeed, run: Run<T>): Promise<Routed<T>> {
	const entries = imageEntries();
	const entry = entries.find((e) => e.name === name);
	if (!entry) {
		throw new ImageBackendError(
			'rejected',
			`There is no image model called "${name}". The models are: ${entries.map((e) => e.name).join(', ')}.`
		);
	}
	if (entry.caps && !meetsNeed(entry.caps, need)) {
		const can = capableEntries(need, entries)
			.filter((e) => e.caps)
			.map((e) => e.name);
		throw new ImageBackendError(
			'rejected',
			`${entry.name} ${cannot(need, entry.caps)}.` +
				(can.length ? ` ${can.join(', ')} can.` : ` ${noneCanSay(need, savedCaps(entries))}`)
		);
	}
	const { backend, caps } = await ready(entry, need);
	return { entry, backend, caps, value: await run(entry, backend, caps) };
}

/**
 * Run `need` on the first entry that can do it and answers, and say which ran.
 * See the top of this file.
 */
export async function routeImage<T>(
	need: ImageNeed,
	run: Run<T>,
	opts: RouteOptions = {}
): Promise<Routed<T>> {
	const entries = imageEntries();
	if (entries.length === 0 && !opts.prefer) throw new ImageBackendError('unconfigured', NOT_SET_UP);
	if (opts.named) return routeNamed(opts.named, need, run);

	const capable = capableEntries(need, entries);
	const order = opts.prefer
		? [opts.prefer, ...capable.filter((e) => e.id !== opts.prefer!.id)]
		: capable;
	if (order.length === 0) {
		throw new ImageBackendError('unconfigured', noneCanSay(need, savedCaps(entries)));
	}

	const missed: { entry: ImageModelEntry; error: ImageBackendError }[] = [];
	for (const entry of order) {
		let got: { backend: ImageBackend; caps: ImageBackendCapabilities };
		try {
			got = await ready(entry, need);
		} catch (e) {
			if (!passOver(e)) throw e;
			missed.push({ entry, error: e as ImageBackendError });
			logDebug('image', `${entry.name} passed over: ${errMessage(e)}`);
			continue;
		}
		try {
			return { entry, ...got, value: await run(entry, got.backend, got.caps) };
		} catch (e) {
			if (!passOver(e)) throw e;
			missed.push({ entry, error: e as ImageBackendError });
			logDebug('image', `${entry.name} failed, trying the next: ${errMessage(e)}`);
		}
	}
	// None could, now that they were asked: say what can, as before there was a list.
	if (missed.every((m) => m.error instanceof CannotDo)) {
		const live = missed.map((m) => (m.error as CannotDo).caps);
		throw new ImageBackendError('unconfigured', noneCanSay(need, [...live, ...savedCaps(entries)]));
	}
	// One entry: its own error, as before there was a list.
	if (missed.length === 1) throw missed[0].error;
	throw new ImageBackendError(
		'unreachable',
		'No image model answered: ' +
			missed.map((m) => `${m.entry.name} (${placeOf(m.entry)}): ${m.error.message}`).join('; ') +
			'.'
	);
}

/** A transparent drawing: what the asset job asks for. */
const DRAWING: ImageNeed = { ...upscaleNeed(), op: 'draw', transparent: true };

/**
 * The entry a transparent drawing would go to, without asking any server: the
 * model the asset job plans its sizes and its report around.
 */
export function drawingEntry(): ImageModelEntry | null {
	return capableEntries(DRAWING)[0] ?? null;
}

/**
 * An `ImageBackend` that routes each call, for callers written against one
 * backend (the asset job). `capabilities` is what a transparent drawing would
 * get, since that is what the asset job asks before it draws.
 */
export function routedImageBackend(): ImageBackend {
	const drawing = DRAWING;
	const first = drawingEntry();
	return {
		kind: first?.backend ?? 'none',
		capabilities: async () =>
			(await capabilitiesFor(drawing)) ?? {
				transparency: false,
				seamlessTiling: false,
				loras: false,
				maxLoras: 0
			},
		probe: async () => {
			if (!first) return { ok: false, detail: NOT_SET_UP };
			return backendForEntry(first)?.probe() ?? { ok: false, detail: NOT_SET_UP };
		},
		generate: async (req: ImageRequest, opts?: GenerateOptions): Promise<ImageResult> =>
			(await routeImage(needOf(req), (_e, b) => b.generate(req, opts))).value,
		upscale: async (input, opts) =>
			(await routeImage(upscaleNeed(), (_e, b) => b.upscale!(input, opts))).value
	};
}
