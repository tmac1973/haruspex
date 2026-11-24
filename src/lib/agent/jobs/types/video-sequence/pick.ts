/**
 * Which video models a Video sequence run uses: the job's named ones, or on
 * Automatic, picked once before the spec is written, since the picked
 * model's limits shape the plan.
 *
 * - The video model on Automatic is the first in Settings → Video generation
 *   that answers and makes clips from a prompt or a picture without speech,
 *   preferring one that can also end on a picture (the planner chains clips
 *   on end frames only when the model can).
 * - The speaking model on Automatic is the first that makes someone speak,
 *   or none.
 */
import { readyEntry } from '#lib/videogen/route.ts';
import { videoEntries, videoEntryById } from '#lib/videogen/entries.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { hostOf } from '#lib/toolchest/client.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { VideoCaps, VideoModelEntry } from '#lib/videogen/types.ts';
import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';

export interface PickedModel {
	entry: VideoModelEntry;
	backend: VideoBackend;
	caps: VideoCaps;
}

/** The value of `speaking_model_id` that means no speaking model. */
export const NO_SPEAKER = 'none';

const makesClips = (c: VideoCaps) => (c.text || c.startImage) && !c.needsSpeech;

/** `id`'s entry, ready, or why not. */
async function named(id: string, signal?: AbortSignal): Promise<PickedModel> {
	const entry = videoEntryById(id);
	if (!entry) {
		throw new Error(
			`The job's video model is no longer in Settings → Video generation; choose another in the job.`
		);
	}
	return { entry, ...(await readyEntry(entry, signal)) };
}

/**
 * The first entries, in order, that answer and pass `fits`, or each one's
 * reason. Entries known not to fit are not asked.
 */
async function firstFitting(
	fits: (c: VideoCaps) => boolean,
	signal?: AbortSignal
): Promise<{ found: PickedModel[]; reasons: string[] }> {
	const found: PickedModel[] = [];
	const reasons: string[] = [];
	for (const entry of videoEntries()) {
		if (entry.caps && !fits(entry.caps)) {
			reasons.push(`${entry.name}: can't make clips without speech`);
			continue;
		}
		try {
			const ready = await readyEntry(entry, signal);
			if (fits(ready.caps)) found.push({ entry, ...ready });
			else reasons.push(`${entry.name}: can't make clips without speech`);
		} catch (e) {
			if (!(e instanceof VideoBackendError)) throw e;
			const where = entry.url.trim() ? ` (${hostOf(entry.url)})` : '';
			reasons.push(`${entry.name}${where}: ${errMessage(e).replace(/\.$/, '')}`);
		}
	}
	return { found, reasons };
}

/** The run's video model. */
export async function pickVideoModel(
	cfg: VideoSequenceConfig,
	signal?: AbortSignal
): Promise<PickedModel> {
	if (cfg.video_model_id) return named(cfg.video_model_id, signal);
	const { found, reasons } = await firstFitting(makesClips, signal);
	const best = found.find((p) => p.caps.endImage) ?? found[0];
	if (best) return best;
	throw new Error(
		'No video model in Settings → Video generation can make a clip from a prompt or a picture.' +
			(reasons.length ? ` ${reasons.join('; ')}.` : '')
	);
}

/** The run's speaking model, or null for none. */
export async function pickSpeakingModel(
	cfg: VideoSequenceConfig,
	signal?: AbortSignal
): Promise<PickedModel | null> {
	if (cfg.speaking_model_id === NO_SPEAKER) return null;
	if (cfg.speaking_model_id) return named(cfg.speaking_model_id, signal);
	for (const entry of videoEntries()) {
		if (entry.caps && !entry.caps.speech) continue;
		try {
			const ready = await readyEntry(entry, signal);
			if (ready.caps.speech) return { entry, ...ready };
		} catch (e) {
			if (!(e instanceof VideoBackendError)) throw e;
		}
	}
	return null;
}

/** What the picked model's caps say, as the validator's capability words. */
export function capabilityWords(caps: VideoCaps): string[] {
	return [
		...(caps.text ? ['text'] : []),
		...(caps.startImage ? ['start_image'] : []),
		...(caps.endImage ? ['end_image'] : []),
		...(caps.speech ? ['audio'] : [])
	];
}

/** What the other video models can do that `picked` can't, for Automatic. */
export function othersCan(picked: PickedModel): string[] {
	const mine = new Set(capabilityWords(picked.caps));
	const theirs = videoEntries()
		.filter((e) => e.id !== picked.entry.id && e.caps && !e.caps.needsSpeech)
		.flatMap((e) => capabilityWords(e.caps!));
	return [...new Set(theirs)].filter((c) => !mine.has(c));
}
