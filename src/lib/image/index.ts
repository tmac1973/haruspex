/**
 * Image-backend registration barrel. Import THIS from anything that needs the
 * built-in backends registered, never `./registry` directly — the same
 * arrangement the job-type registry uses.
 */

import { registerImageBackend } from '#lib/image/registry.ts';
import { comfyUiBackend } from '#lib/image/comfyui/backend.ts';
import { localBackend } from '#lib/image/local/backend.ts';

registerImageBackend(comfyUiBackend);
registerImageBackend(localBackend);

export {
	resolveImageBackend,
	type ImageBackend,
	type GenerateOptions
} from '#lib/image/backend.ts';
export { getImageBackend, listImageBackends, registerImageBackend } from '#lib/image/registry.ts';
export { noneBackend } from '#lib/image/none.ts';
export { localBackend } from '#lib/image/local/backend.ts';
export * from '#lib/image/types.ts';
