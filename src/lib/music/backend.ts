/**
 * The interface every music backend implements, and the resolver that picks
 * the configured one, as `image/backend.ts` does for pictures.
 */

import { getSettings } from '#lib/stores/settings.ts';
import { getMusicBackend } from '#lib/music/registry.ts';
import { noneMusicBackend } from '#lib/music/none.ts';
import type {
	MusicBackendKind,
	MusicGenerateOptions,
	MusicRequest,
	MusicResult
} from '#lib/music/types.ts';
import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';

export type { ModelOption, ProbeResult };

export interface MusicBackend {
	kind: MusicBackendKind;
	/** Is it reachable and usable? Lists its models when it can. */
	probe(): Promise<ProbeResult>;
	generate(req: MusicRequest, opts?: MusicGenerateOptions): Promise<MusicResult>;
}

/** The configured backend, or the no-op one for an unset or unknown kind. */
export function resolveMusicBackend(): MusicBackend {
	return getMusicBackend(getSettings().musicBackendKind) ?? noneMusicBackend;
}
