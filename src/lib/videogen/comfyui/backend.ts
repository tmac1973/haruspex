/**
 * Video models on a ComfyUI server the user runs: one backend per video model
 * in Settings → Video generation. The model is a file on the server; its name
 * says its family (`./families.ts`), which says what it can do and which
 * workflow runs it (`./graphs.ts`).
 *
 * A clip is a prompt on ComfyUI's queue, followed over its progress socket
 * and history (`#lib/comfyui/run.ts`) for up to an hour, then downloaded
 * straight into the audio cache by Rust (`audio_store_url`) from the server's
 * `/view` route, so it never crosses the bridge. Pictures and speech go up
 * from the caches the same way. The prompt's id is reported as soon as it is
 * queued, so a restart can follow it again.
 */
import { invoke } from '@tauri-apps/api/core';
import * as api from '#lib/comfyui/client.ts';
import { resumeForFiles, runForFiles, type Follow, type RunOptions } from '#lib/comfyui/run.ts';
import { uploadCachedAudio, uploadImage } from '#lib/comfyui/upload.ts';
import { ImageBackendError, type ImageProgress } from '#lib/image/types.ts';
import { toolchestKeyFor } from '#lib/toolchest/models.ts';
import { errMessage } from '#lib/utils/error.ts';
import type { StoredAudio } from '#lib/ipc/gen/StoredAudio.ts';
import { VideoBackendError, type VideoBackend } from '#lib/videogen/backend.ts';
import { registerVideoBackendKind } from '#lib/videogen/registry.ts';
import { videoEntryApiKey } from '#lib/videogen/entries.ts';
import { clipHasAudio } from '#lib/videogen/clip.ts';
import { stepFrames } from '#lib/videogen/fit.ts';
import { videoSrc } from '#lib/videogen/url.ts';
import {
	FAMILY_CAPS,
	FAMILY_LABELS,
	listVideoModels,
	missingNodes,
	modelLoader,
	resolveCompanions,
	videoFamilyOf,
	type VideoFamily
} from '#lib/videogen/comfyui/families.ts';
import { OUTPUT_NODE, buildVideoGraph } from '#lib/videogen/comfyui/graphs.ts';
import { optionsOf } from '#lib/comfyui/nodes.ts';
import type {
	VideoCaps,
	VideoGenerateOptions,
	VideoJobHandle,
	VideoModelEntry,
	VideoProgress,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';

/** One clip, queue time included: a 14B clip on a busy card takes many minutes. */
export const VIDEO_TIMEOUT_MS = 3_600_000;

const FOLLOW: Follow = { deadlineMs: VIDEO_TIMEOUT_MS, files: 'any' };

const SECTION = 'Settings → Video generation';

/** The shared client's error as a video backend's, worded for this section. */
function toVideoError(e: unknown): unknown {
	if (e instanceof VideoBackendError || !(e instanceof ImageBackendError)) return e;
	const message = e.message
		.replace(/the image backend/gi, 'ComfyUI')
		.replace(/Settings → Image generation/g, SECTION);
	return new VideoBackendError(e.kind, message, { status: e.status });
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		throw toVideoError(e);
	}
}

/** ComfyUI's progress in a clip's words. */
function videoProgress(p: ImageProgress): VideoProgress {
	if (p.phase === 'queued') return { phase: 'queued', ...(p.ahead ? { ahead: p.ahead } : {}) };
	if (p.phase === 'loading') return { phase: 'starting' };
	if (p.phase === 'downloading') return { phase: 'saving' };
	return {
		phase: 'generating',
		...(p.totalSteps ? { step: p.step ?? 0, totalSteps: p.totalSteps } : {})
	};
}

function runOptions(opts: VideoGenerateOptions): RunOptions<VideoJobHandle> {
	return {
		signal: opts.signal,
		onProgress: (p) => opts.onProgress?.(videoProgress(p)),
		onHandle: opts.onHandle
	};
}

/** `entry`'s family, or why it has none. */
function familyOf(entry: VideoModelEntry): VideoFamily {
	if (!entry.model.trim()) {
		throw new VideoBackendError('unconfigured', `${entry.name} has no model chosen — ${SECTION}.`);
	}
	const family = videoFamilyOf(entry.model);
	if (!family) {
		throw new VideoBackendError(
			'unconfigured',
			`${entry.model} is not a video model Haruspex can run.`
		);
	}
	return family;
}

/** The clip in the server's output folder, into the audio cache; what was made. */
async function keep(
	cfg: api.ClientConfig,
	file: api.HistoryImage,
	req: VideoRequest,
	frames: number,
	model: string,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	opts.onProgress?.({ phase: 'saving' });
	const stored = await invoke<StoredAudio>('audio_store_url', {
		url: `${api.trimUrl(cfg.baseUrl)}${api.viewPath(file)}`,
		apiKey: cfg.apiKey || null,
		mimeHint: /\.mp4$/i.test(file.filename) ? 'video/mp4' : 'video/webm',
		title: req.title || null,
		conversationId: opts.conversationId ?? null,
		codeSessionId: opts.codeSessionId ?? null
	});
	return {
		hash: stored.hash,
		url: videoSrc(stored.hash) ?? '',
		mime: stored.mime,
		width: req.width,
		height: req.height,
		frames,
		fps: req.fps,
		seed: req.seed,
		model,
		hasAudio: await clipHasAudio(stored.hash)
	};
}

/** Upload what `req` sends, run its family's graph and keep the clip. */
async function generateOn(
	entry: VideoModelEntry,
	cfg: api.ClientConfig,
	req: VideoRequest,
	opts: VideoGenerateOptions
): Promise<VideoResult> {
	const family = familyOf(entry);
	const caps = FAMILY_CAPS[family];
	const { found, missing } = await resolveCompanions(cfg, family);
	if (missing.length) {
		throw new VideoBackendError(
			'unconfigured',
			`Missing on the server: ${missing.join(', ')}. ${SECTION} → Install adds them.`
		);
	}
	if (req.audio && !caps.speech) {
		throw new VideoBackendError('rejected', `${entry.name} can't make someone speak.`);
	}
	if (req.endImage && !caps.endImage) {
		throw new VideoBackendError('rejected', `${entry.name} can't end on a picture.`);
	}
	const clientId = crypto.randomUUID();
	const up = (img: { name: string; hash: string }, role: string) =>
		uploadImage(cfg, img, `haruspex-${role}-${clientId}.png`, opts.signal);
	const startImage = req.startImage ? await up(req.startImage, 'start') : undefined;
	const endImage = req.endImage ? await up(req.endImage, 'end') : undefined;
	const audio = req.audio
		? await uploadCachedAudio(
				cfg,
				req.audio.hash,
				`haruspex-speech-${clientId}.${req.audio.name.split('.').pop() || 'wav'}`,
				opts.signal
			)
		: undefined;
	const most = caps.limits.maxFrames ?? req.frames;
	const frames = stepFrames(Math.min(req.frames, most), caps.frameStep);
	const graph = buildVideoGraph(family, {
		model: entry.model,
		companions: found,
		prompt: req.prompt,
		negativePrompt: req.negativePrompt,
		width: req.width,
		height: req.height,
		frames,
		fps: req.fps,
		seed: req.seed,
		startImage,
		endImage,
		audio,
		prefix: `haruspex/${clientId}`
	});
	const files = await runForFiles<VideoJobHandle>(
		cfg,
		graph,
		OUTPUT_NODE,
		clientId,
		runOptions(opts),
		(id) => ({
			backend: 'comfyui',
			baseUrl: cfg.baseUrl,
			id,
			model: entry.model,
			keyId: entry.keyId ?? '',
			extra: { clientId, outputNode: OUTPUT_NODE, frames: String(frames) }
		}),
		FOLLOW
	);
	return keep(cfg, files[0], req, frames, entry.name, opts);
}

/** The backend for one ComfyUI video model. */
export function comfyVideoFor(entry: VideoModelEntry): VideoBackend {
	const config = async (): Promise<api.ClientConfig> => ({
		baseUrl: entry.url.trim(),
		apiKey: await videoEntryApiKey(entry)
	});

	async function models(cfg: api.ClientConfig) {
		return (await listVideoModels(cfg)).map((m) => ({
			name: m.name,
			label: `${m.name} — ${FAMILY_LABELS[m.family]}`
		}));
	}

	async function probe() {
		if (!entry.url.trim()) return { ok: false, detail: `No ComfyUI server is set — ${SECTION}.` };
		const cfg = await config();
		try {
			await api.systemStats(cfg);
		} catch (e) {
			return { ok: false, detail: errMessage(toVideoError(e)) };
		}
		const list = await models(cfg);
		if (!entry.model.trim()) return { ok: false, detail: 'Choose a video model.', models: list };
		const family = videoFamilyOf(entry.model);
		if (!family) {
			return {
				ok: false,
				detail: `${entry.model} is not a video model Haruspex can run.`,
				models: list
			};
		}
		const nodes = await missingNodes(cfg, family);
		if (nodes.length) {
			return {
				ok: false,
				detail: `This ComfyUI has no ${nodes.join(', ')} node; update ComfyUI.`,
				models: list
			};
		}
		const loader = modelLoader(family);
		const have = await optionsOf(cfg, loader.cls, loader.input).catch((): string[] => []);
		const { missing } = await resolveCompanions(cfg, family);
		const absent = [...(have.includes(entry.model) ? [] : [entry.model]), ...missing];
		if (absent.length) {
			return {
				ok: false,
				detail: `Missing on the server: ${absent.join(', ')}. ${SECTION} → Install adds them.`,
				models: list
			};
		}
		return { ok: true, detail: `Connected — ${FAMILY_LABELS[family]}.`, models: list };
	}

	return {
		kind: 'comfyui',
		probe: () => mapped(probe),
		capabilities: async (): Promise<VideoCaps> => FAMILY_CAPS[familyOf(entry)],
		models: () => mapped(async () => models(await config())),
		generate: (req, opts = {}) => mapped(async () => generateOn(entry, await config(), req, opts)),
		resume: (handle, req, opts = {}) =>
			mapped(async () => {
				const cfg = {
					baseUrl: handle.baseUrl,
					apiKey: await toolchestKeyFor(handle.keyId || null)
				};
				const files = await resumeForFiles(cfg, handle, runOptions(opts), FOLLOW);
				const frames = Number(handle.extra?.frames) || req.frames;
				const name =
					handle.entryId === entry.id && handle.model === entry.model ? entry.name : handle.model;
				return keep(cfg, files[0], req, frames, name, opts);
			})
	};
}

registerVideoBackendKind('comfyui', comfyVideoFor);
