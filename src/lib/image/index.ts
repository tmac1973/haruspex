/**
 * Image-backend registration barrel. Import THIS from anything that needs the
 * built-in backends registered, never `./registry` directly — the same
 * arrangement the job-type registry uses.
 */

// Each registers its kind's factory as it loads.
import '#lib/image/comfyui/backend.ts';
import '#lib/image/local/backend.ts';
import '#lib/image/lemonade/backend.ts';
import '#lib/image/toolchest/backend.ts';

export {
	resolveImageBackend,
	type ImageBackend,
	type GenerateOptions
} from '#lib/image/backend.ts';
export {
	backendForEntry,
	getImageBackend,
	listImageBackends,
	registerImageBackend
} from '#lib/image/registry.ts';
export { routedImageBackend } from '#lib/image/route.ts';
export { noneBackend } from '#lib/image/none.ts';
export { localBackend } from '#lib/image/local/backend.ts';
export * from '#lib/image/types.ts';
