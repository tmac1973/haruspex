/**
 * A video backend: one video model on one server, built from its entry in
 * Settings → Video generation (`#lib/videogen/registry.ts`). Every backend
 * reports what it can do as `VideoCaps`, so the tool and jobs check one shape.
 */

import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
import type {
	VideoBackendKind,
	VideoCaps,
	VideoGenerateOptions,
	VideoJobHandle,
	VideoRequest,
	VideoResult
} from '#lib/videogen/types.ts';

export type VideoBackendErrorKind =
	'unconfigured' | 'unreachable' | 'timeout' | 'rejected' | 'cancelled';

export class VideoBackendError extends Error {
	readonly kind: VideoBackendErrorKind;
	readonly status?: number;

	constructor(kind: VideoBackendErrorKind, message: string, opts: { status?: number } = {}) {
		super(message);
		this.name = 'VideoBackendError';
		this.kind = kind;
		this.status = opts.status;
	}
}

export interface VideoBackend {
	kind: VideoBackendKind;
	/** Reachable, with the key, and the model there. `models` lists what may be chosen. */
	probe(signal?: AbortSignal): Promise<ProbeResult>;
	/** What the model can do now; throws when it can't make clips at all. */
	capabilities(signal?: AbortSignal): Promise<VideoCaps>;
	generate(req: VideoRequest, opts?: VideoGenerateOptions): Promise<VideoResult>;
	/** Follow a job an earlier run sent, on the server its handle names. */
	resume(
		handle: VideoJobHandle,
		req: VideoRequest,
		opts?: VideoGenerateOptions
	): Promise<VideoResult>;
	/** The models the server offers, for Settings' dropdown. */
	models?(signal?: AbortSignal): Promise<ModelOption[]>;
}
