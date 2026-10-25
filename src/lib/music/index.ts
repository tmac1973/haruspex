/**
 * Music-backend registration barrel. Import THIS from anything that needs the
 * built-in backends registered, never `./registry` directly.
 */

import { registerMusicBackend } from '#lib/music/registry.ts';
import { toolchestMusicBackend } from '#lib/music/toolchest/backend.ts';

registerMusicBackend(toolchestMusicBackend);

export { resolveMusicBackend, type MusicBackend } from '#lib/music/backend.ts';
export * from '#lib/music/types.ts';
