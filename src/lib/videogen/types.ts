/**
 * Video generation's shapes: one request makes one clip on a llama-toolchest
 * video instance (Settings → Video generation). Clips are kept in the same
 * cache as songs, and named by a `haruspex-video:` URL so an answer shows a
 * video player for them.
 */

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
	backend: 'llama-toolchest';
	baseUrl: string;
	id: string;
	model: string;
	/** The API key's id in the key store; empty for none. */
	keyId: string;
}

export interface VideoGenerateOptions {
	signal?: AbortSignal;
	onProgress?: (p: VideoProgress) => void;
	onHandle?: (handle: VideoJobHandle) => void;
	/** Who the clip belongs to, so the cache keeps it: a chat or a Code session. */
	conversationId?: string;
	codeSessionId?: string;
	/** An instance on the same server, instead of the one Settings → Video generation names. */
	instanceId?: string;
}
