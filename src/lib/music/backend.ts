/**
 * The interface every music backend implements, and the resolver that picks
 * the configured one, as `image/backend.ts` does for pictures.
 */

import { getSettings } from '#lib/stores/settings.ts';
import { getMusicBackend } from '#lib/music/registry.ts';
import { noneMusicBackend } from '#lib/music/none.ts';
import { servedByOf } from '#lib/generation/entry.ts';
import type {
	MusicBackendKind,
	MusicGenerateOptions,
	MusicJobHandle,
	MusicRequest,
	MusicResult,
	MusicTask
} from '#lib/music/types.ts';
import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';

export type { ModelOption, ProbeResult };

export interface MusicBackend {
	kind: MusicBackendKind;
	/** Is it reachable and usable? Lists its models when it can. */
	probe(): Promise<ProbeResult>;
	/** The tasks the chosen model runs; `text2music` alone on a server that says nothing. */
	tasks(): Promise<MusicTask[]>;
	generate(req: MusicRequest, opts?: MusicGenerateOptions): Promise<MusicResult>;
	/**
	 * Follow a job `generate` reported through `onHandle` to its end, from a
	 * later run of the app; `req` is the request it was sent for.
	 */
	resume?(
		handle: MusicJobHandle,
		req: MusicRequest,
		opts?: MusicGenerateOptions
	): Promise<MusicResult>;
}

/** The configured backend, or the no-op one for an unset or unknown kind. */
export function resolveMusicBackend(): MusicBackend {
	return getMusicBackend(getSettings().musicBackendKind) ?? noneMusicBackend;
}

/** Which backend a song came from, for its answer: "ace-server at compute2:8080". */
export function musicServedBy(kind: MusicBackendKind, url: string): string {
	return kind === 'none' ? '' : servedByOf(kind, url);
}

/** Which backend Settings → Music generation sends songs to now. */
export function configuredMusicServedBy(): string {
	const s = getSettings();
	const url = s.musicBackendKind === 'ace-server' ? s.musicAceBaseUrl : s.musicToolchestBaseUrl;
	return musicServedBy(s.musicBackendKind, url ?? '');
}
