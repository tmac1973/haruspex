import type { ImageBackendKind, ImageResult, LoraRef, SamplerSettings } from '#lib/image/types.ts';
import { pngSize } from '#lib/utils/png.ts';

/** What a backend knows about the pictures it just made. */
export interface MadeImages {
	backend: ImageBackendKind;
	/** The size asked for; each picture's own when `sizeFromPng` can't read it. */
	width: number;
	height: number;
	seed: number;
	model: string;
	sampler: SamplerSettings;
	/** As the backend RESOLVED them; none when left out. */
	loras?: LoraRef[];
	/** `Date.now()` when the work began. */
	started: number;
	seamFailed?: string;
	transparencyFailed?: string;
	/** Read each picture's size from its PNG header, for a backend that may not draw the size asked for. */
	sizeFromPng?: boolean;
}

/** PNG bytes from any backend, shaped into the result every caller reads. */
export function toImageResult(images: Uint8Array[], made: MadeImages): ImageResult {
	const asked = { width: made.width, height: made.height };
	return {
		images: images.map((bytes) => ({
			bytes,
			mimeType: 'image/png',
			...((made.sizeFromPng ? pngSize(bytes) : null) ?? asked)
		})),
		meta: {
			seed: made.seed,
			model: made.model,
			backend: made.backend,
			sampler: made.sampler,
			loras: made.loras ?? [],
			durationMs: Date.now() - made.started,
			...(made.seamFailed ? { seamFailed: made.seamFailed } : {}),
			...(made.transparencyFailed ? { transparencyFailed: made.transparencyFailed } : {})
		}
	};
}
