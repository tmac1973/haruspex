/**
 * Video generation's shapes: one request makes one clip on one of the video
 * models in Settings → Video generation (a llama-toolchest instance or a
 * ComfyUI model). Clips are kept in the same cache as songs, and named by a
 * `haruspex-video:` URL so an answer shows a video player for them.
 */

import type { GenerationEntry } from '#lib/generation/entry.ts';
import type { VideoLimits, VupscaleLimits } from '#lib/toolchest/models.ts';

/** A server kind that can make clips. */
export type VideoBackendKind = 'llama-toolchest' | 'comfyui';

/**
 * What one video model can do and make, as its backend reports it: the same
 * shape for every backend, so the tools and jobs check one thing.
 */
export interface VideoCaps {
	/** A clip from the prompt alone. */
	text: boolean;
	startImage: boolean;
	endImage: boolean;
	/** A person in the start image says the given speech (Wan2.2 S2V). */
	speech: boolean;
	/** It can't make a clip without speech. */
	needsSpeech: boolean;
	/** The clip has its own sound track (LTX-2.3). */
	sound: boolean;
	limits: VideoLimits;
	/** Frame counts are `frameStep × n + 1`: 4 for Wan, 8 for LTX. */
	frameStep: number;
	/** Empty when the backend doesn't say. */
	licence: string;
	/** Null when the licence isn't one Haruspex knows. */
	commercialUse: boolean | null;
}

/** One video model on one server, as Settings → Video generation keeps it. */
export type VideoModelEntry = GenerationEntry<VideoBackendKind, VideoCaps>;

/** A picture the clip starts from, in the image cache. */
export interface VideoStartImage {
	name: string;
	hash: string;
}

/** One clip, settled: its size and frame count already fit the instance. */
export interface VideoRequest {
	/** What the player and a saved file are called. */
	title: string;
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	seed: number;
	startImage?: VideoStartImage;
	/** A picture the clip ends on, on an instance with `end_image`. */
	endImage?: VideoStartImage;
	/**
	 * Speech the clip's person says, in the audio cache, on an instance with
	 * the `audio` capability (Wan2.2 S2V).
	 */
	audio?: { name: string; hash: string };
	/** Send no length: the server makes the clip as long as `audio`. */
	followAudio?: boolean;
}

/** A video upscaler on a server, and what it takes. */
export interface VideoUpscaler {
	/** The instance id: what a request's `model` names. */
	id: string;
	limits: VupscaleLimits;
}

/** A clip as `video_upscale_input` keeps it: MJPEG AVI in the audio cache. */
export interface UpscaleClip {
	hash: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	hasAudio: boolean;
}

/** One clip to make larger, settled: converted, and checked against the upscaler. */
export interface VideoUpscaleRequest {
	/** What the player and a saved file are called. */
	title: string;
	input: UpscaleClip;
	/** The upscaler instance on its entry's server. */
	upscaler: string;
	scale: number;
	seed: number;
}

export interface VideoProgress {
	phase: 'queued' | 'starting' | 'generating' | 'saving';
	/** While queued, the jobs ahead of this one. */
	ahead?: number;
	step?: number;
	totalSteps?: number;
}

/** A finished clip, in the cache. */
export interface VideoResult {
	hash: string;
	/** Its `haruspex-video:` URL. */
	url: string;
	mime: string;
	width: number;
	height: number;
	frames: number;
	fps: number;
	seed: number;
	/** The instance that made it. */
	model: string;
	/** The clip has a sound track (LTX-2.3 makes one; Wan doesn't). */
	hasAudio: boolean;
}

/**
 * A job a server holds, as `onHandle` reports it: enough to follow it to its
 * end on the server it went to, whatever the settings say now. Plain JSON:
 * it is saved with the task.
 */
export interface VideoJobHandle {
	backend: VideoBackendKind;
	baseUrl: string;
	id: string;
	model: string;
	/** The API key's id in the key store; empty for none. */
	keyId: string;
	/** The video model it was sent for; absent from a handle saved before the list. */
	entryId?: string;
	/** What one backend needs to follow it, such as ComfyUI's client id. */
	extra?: Record<string, string>;
}

export interface VideoGenerateOptions {
	signal?: AbortSignal;
	onProgress?: (p: VideoProgress) => void;
	onHandle?: (handle: VideoJobHandle) => void;
	/** Who the clip belongs to, so the cache keeps it: a chat or a Code session. */
	conversationId?: string;
	codeSessionId?: string;
}
