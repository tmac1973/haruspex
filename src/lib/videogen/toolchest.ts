/**
 * The calls from before the video model list, kept for the callers that
 * still make them (the video-sequence job, Settings → Video generation's
 * single-instance section): each one uses the first video model in Settings →
 * Video generation. The toolchest backend itself is `./toolchest/backend.ts`.
 */

import '#lib/videogen/index.ts';
import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import { toolchestServer } from '#lib/toolchest/kind.ts';
import type { ProbeResult } from '#lib/image/backend.ts';
import { videoBackendForEntry } from '#lib/videogen/registry.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { firstVideoEntry, videoEntryForHandle } from '#lib/videogen/entries.ts';
import type {
	VideoGenerateOptions,
	VideoJobHandle,
	VideoModelEntry,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';

export {
	ROUTES,
	buildVideoBody,
	readVideoJob,
	videoFiles,
	videoProgressOf,
	type VideoJob
} from '#lib/videogen/toolchest/backend.ts';
export { clipHasAudio } from '#lib/videogen/clip.ts';

const NOT_SET_UP = 'Video generation is not set up — Settings → Video generation.';

function backendOf(entry: VideoModelEntry | null): VideoBackend {
	const backend = entry && videoBackendForEntry(entry);
	if (!backend) throw new VideoBackendError('unconfigured', NOT_SET_UP);
	return backend;
}

/** The first video model on llama-toolchest, as the single-instance calls below see it. */
function firstToolchest() {
	const e = firstVideoEntry();
	return e?.backend === 'llama-toolchest' ? e : null;
}

const server = toolchestServer('video', () => {
	const e = firstToolchest();
	return { baseUrl: e?.url ?? '', keyId: e?.keyId ?? null, modelId: e?.model ?? '' };
});

/** Every video instance the last probe saw. */
export const seenVideoInstances = server.seen;

/**
 * The first video model's instance (or `id`, on the same server), running, or
 * why it can't make a clip now.
 */
export async function readyVideoInstance(
	signal?: AbortSignal,
	id?: string
): Promise<ToolchestInstance> {
	return server.readyInstance(await server.config(), signal, id);
}

/** The video instances on the first video model's server. */
export async function listVideoInstances(signal?: AbortSignal): Promise<ToolchestInstance[]> {
	return server.instances(await server.config(), signal);
}

/** The instance the first video model names. */
export function chosenVideoInstanceId(): string {
	return server.chosenId();
}

/** Reachable, and the first video model's instance running. */
export function probeVideo(): Promise<ProbeResult> {
	return server.probe();
}

/** Make the clip on the first video model. */
export function generateVideo(
	req: VideoRequest,
	opts: VideoGenerateOptions = {}
): Promise<VideoResult> {
	return backendOf(firstVideoEntry()).generate(req, opts);
}

/** Follow a job an earlier run sent, on the server it went to, whatever the settings say now. */
export function resumeVideo(
	handle: VideoJobHandle,
	req: VideoRequest,
	opts: VideoGenerateOptions = {}
): Promise<VideoResult> {
	return backendOf(videoEntryForHandle(handle)).resume(handle, req, opts);
}
