/**
 * The music layer's shapes, as `image/types.ts` has the image layer's. One
 * request makes one song; which server makes it is the backend's business.
 */

/** Which server makes music, if any. `'none'` is the shipped default. */
export type MusicBackendKind = 'none' | 'llama-toolchest' | 'ace-server';

/**
 * What a request does, as ACE-Step names it. `text2music` writes a new song;
 * the rest work on a `source` song: `cover` restyles it, `repaint` redoes a
 * stretch (and extends it, with a window past either end), `lego` adds an
 * instrument, `extract` pulls one out and `complete` fills in the rest.
 */
export type MusicTask = 'text2music' | 'cover' | 'repaint' | 'lego' | 'extract' | 'complete';

export const MUSIC_TASKS: MusicTask[] = [
	'text2music',
	'cover',
	'repaint',
	'lego',
	'extract',
	'complete'
];

/** The instruments ACE-Step knows, for `lego`, `extract` and `complete`. */
export const MUSIC_TRACKS = [
	'vocals',
	'backing_vocals',
	'drums',
	'bass',
	'guitar',
	'keyboard',
	'percussion',
	'strings',
	'synth',
	'fx',
	'brass',
	'woodwinds'
] as const;

/**
 * A song sent with a request: one in the audio cache by hash, or the bytes of
 * a file read from the working folder. Rust reads a cached one itself, so it
 * never crosses the bridge.
 */
export type MusicInput = { name: string } & ({ hash: string } | { bytes: number[] });

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
	/** Default `text2music`; every other task needs a `source`. */
	task?: MusicTask;
	/** The song the task works on. */
	source?: MusicInput;
	/** A song whose sound (timbre) to borrow; any task takes one. */
	reference?: MusicInput;
	/** The instrument for `lego` and `extract`; `complete` takes several. */
	tracks?: string[];
	/** For `cover`, 0–1: how closely it follows the source. */
	coverStrength?: number;
	/** The stretch `repaint` redoes, in seconds; past either end extends the song. */
	repaintStart?: number;
	repaintEnd?: number;
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
	/** Called once the server holds the job, and again when it moves to another. */
	onHandle?: (handle: MusicJobHandle) => void;
}

/**
 * A job a server holds, as `onHandle` reports it: enough for `resume` to
 * follow it to its end on the server it went to, whatever the settings say
 * now. Plain JSON: it is saved with the task.
 */
export interface MusicJobHandle {
	backend: MusicBackendKind;
	baseUrl: string;
	/** The server's id for the job. */
	id: string;
	/** The instance or model that makes it, as the result reports it. */
	model: string;
	/** ace-server's two jobs: `lm` composes, then `synth` renders. */
	stage?: 'lm' | 'synth';
	/** What composing settled, once a `synth` job is sent. */
	facts?: { bpm?: number; duration?: number; keyscale?: string; seed?: number };
	/** Anything else the backend needs: toolchest's key id, ace-server's synthesis model. */
	extra?: Record<string, string>;
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
