/**
 * Music-backend registry: backend modules self-register, and callers resolve
 * one through settings. Import `./index.ts` (the registration barrel) from
 * anything that needs the built-in backends registered.
 */

import type { MusicBackend } from '#lib/music/backend.ts';
import type { MusicBackendKind } from '#lib/music/types.ts';

const backends = new Map<MusicBackendKind, MusicBackend>();

export function registerMusicBackend(backend: MusicBackend): void {
	backends.set(backend.kind, backend);
}

export function getMusicBackend(kind: MusicBackendKind): MusicBackend | undefined {
	return backends.get(kind);
}
