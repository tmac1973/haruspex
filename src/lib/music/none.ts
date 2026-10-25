/** The backend for "nothing is configured": one sentence naming the settings path. */

import type { MusicBackend } from '#lib/music/backend.ts';
import { MusicBackendError } from '#lib/music/types.ts';

const NOT_CONFIGURED = 'No music backend configured — Settings → Music.';

export const noneMusicBackend: MusicBackend = {
	kind: 'none',
	probe: async () => ({ ok: false, detail: NOT_CONFIGURED }),
	tasks: async () => [],
	generate: async () => {
		throw new MusicBackendError('unconfigured', NOT_CONFIGURED);
	}
};
