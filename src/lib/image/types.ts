/**
 * The image-generation layer's vocabulary.
 *
 * Everything here is about producing a picture: a request goes in, bytes and
 * metadata come back. Nothing in this module — or anywhere under
 * `src/lib/image/` — knows what an asset, a spec or an anchor is. That
 * boundary is what lets a future image tab or an inline chat image use this
 * layer as-is, and `layering.test.ts` enforces both halves of it.
 *
 * Every field defined here has a producer and a consumer. Fields nobody reads
 * were deliberately left out (batch counts, a ControlNet flag, a free-form
 * `extra` bag): an unused knob is a capability claim nobody checks, and the
 * job that trusts it stops degrading and starts silently shipping bad output.
 */

/** Which backend implementation a request is served by. */
export type ImageBackendKind = 'none' | 'comfyui' | 'local';

/** Sampler settings, named because the anchor recipe has to store them. */
export interface SamplerSettings {
	name: string;
	steps: number;
	cfg: number;
}

/** One LoRA and how strongly to apply it. */
export interface LoraRef {
	name: string;
	strength: number;
}

/** One generation. */
export interface ImageRequest {
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	/** null = let the backend choose; the resolved value comes back in meta. */
	seed: number | null;
	/**
	 * Checkpoint to generate with. Unset means the backend's configured
	 * default — without this field nobody could choose what makes their art,
	 * and `ImageResult.meta.model` would have no source.
	 */
	model?: string;
	/** Style reference, conditioned on when the backend supports it. */
	referenceImage?: Uint8Array;
	/** How strongly to pull toward `referenceImage`, 0..1. */
	referenceStrength?: number;
	loras?: LoraRef[];
	sampler?: SamplerSettings;
	/** Ask for an edge-wrapping result (terrain textures). */
	seamless?: boolean;
}

/** One generated image. */
export interface GeneratedImage {
	bytes: Uint8Array;
	mimeType: string;
	width: number;
	height: number;
}

/**
 * What actually happened. `sampler` and `loras` are echoed back as the backend
 * RESOLVED them, not as the request left them — a request may set neither, and
 * the anchor recipe has to record what really ran or a later run cannot
 * reproduce the style.
 */
export interface ImageResultMeta {
	seed: number;
	model: string;
	backend: ImageBackendKind;
	sampler: SamplerSettings;
	loras: LoraRef[];
	durationMs: number;
	/** Backend-specific payload, for debugging only. Never parsed. */
	raw?: unknown;
}

export interface ImageResult {
	images: GeneratedImage[];
	meta: ImageResultMeta;
}

/**
 * Progress during a generation. `step`/`totalSteps` are present when the
 * backend reports them, so a UI can show a determinate bar and fall back to an
 * indeterminate one when it cannot.
 */
export interface ImageProgress {
	phase: 'queued' | 'running' | 'downloading';
	step?: number;
	totalSteps?: number;
	detail?: string;
}

/**
 * What a backend can do. Read by the asset job to decide, per entry, which
 * coherence layer it has to do without — so every field here is consulted
 * somewhere, and a backend that lies costs the user a run of off-style art.
 */
export interface ImageBackendCapabilities {
	referenceConditioning: boolean;
	seamlessTiling: boolean;
	loras: boolean;
	/** LoRA slots available; 0 when `loras` is false. */
	maxLoras: number;
}

/**
 * Why a generation failed, as a discriminant rather than decoration: the
 * caller branches on `kind` to decide whether retrying is worth anything.
 * `unreachable` and `timeout` are transient; `rejected` and `unconfigured`
 * are not.
 */
export type ImageBackendErrorKind =
	| 'unconfigured'
	| 'unreachable'
	| 'rejected'
	| 'timeout'
	| 'cancelled';

export class ImageBackendError extends Error {
	readonly kind: ImageBackendErrorKind;
	readonly status?: number;
	readonly body?: string;

	constructor(
		kind: ImageBackendErrorKind,
		message: string,
		opts: { status?: number; body?: string } = {}
	) {
		super(message);
		this.name = 'ImageBackendError';
		this.kind = kind;
		this.status = opts.status;
		this.body = opts.body;
	}
}
