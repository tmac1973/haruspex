/**
 * The music layer's shapes, as `image/types.ts` has the image layer's. One
 * request makes one song; which server makes it is the backend's business.
 */

/** Which server makes music, if any. `'none'` is the shipped default. */
export type MusicBackendKind = 'none' | 'llama-toolchest';

/** One song. */
export interface MusicRequest {
	/** What the player and a saved file are called. */
	title: string;
	/** Genre, mood, instruments and feel, as tags. */
	caption: string;
	/** With `[verse]`/`[chorus]` section tags; empty for an instrumental. */
	lyrics?: string;
	instrumental: boolean;
	durationSec: number;
	bpm?: number;
	/** e.g. `C major`. */
	key?: string;
	timeSignature?: string;
	/** ISO code of the lyrics' language. */
	language?: string;
	seed: number;
	format: 'mp3' | 'wav';
}

export interface MusicProgress {
	/** `running` only for a server that says no more than that. */
	phase: 'queued' | 'running' | 'composing' | 'synthesizing' | 'saving';
	/** While queued, the jobs ahead of this one. */
	ahead?: number;
}

/** A finished song, in the audio cache. */
export interface MusicResult {
	hash: string;
	/** Its `haruspex-audio:` URL, for a player. */
	url: string;
	mime: string;
	durationSec: number;
	seed: number;
	/** The instance (or model) that made it. */
	model: string;
	bpm?: number;
	key?: string;
}

export interface MusicGenerateOptions {
	signal?: AbortSignal;
	onProgress?: (p: MusicProgress) => void;
	/** Who the song belongs to, so the cache keeps it: a chat or a Code session. */
	conversationId?: string;
	codeSessionId?: string;
}

/** As `ImageBackendErrorKind`: `unreachable` and `timeout` are worth retrying. */
export type MusicBackendErrorKind =
	'unconfigured' | 'unreachable' | 'rejected' | 'timeout' | 'cancelled';

export class MusicBackendError extends Error {
	readonly kind: MusicBackendErrorKind;
	readonly status?: number;

	constructor(kind: MusicBackendErrorKind, message: string, opts: { status?: number } = {}) {
		super(message);
		this.name = 'MusicBackendError';
		this.kind = kind;
		this.status = opts.status;
	}
}
