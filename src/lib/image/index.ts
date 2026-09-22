/**
 * Image-backend registration barrel. Import THIS from anything that needs the
 * built-in backends registered, never `./registry` directly — the same
 * arrangement the job-type registry uses.
 */

import { registerImageBackend } from './registry';
import { comfyUiBackend } from './comfyui/backend';

registerImageBackend(comfyUiBackend);

export { resolveImageBackend, type ImageBackend, type GenerateOptions } from './backend';
export { getImageBackend, listImageBackends, registerImageBackend } from './registry';
export { noneBackend } from './none';
export * from './types';
