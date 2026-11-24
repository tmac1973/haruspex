/** What a llama-toolchest video instance can do, as `VideoCaps`. */

import type { ToolchestInstance } from '#lib/toolchest/models.ts';
import type { VideoCaps } from '#lib/videogen/types.ts';

/** LTX makes its own sound and counts frames in eights; toolchest's meta says neither. */
const LTX = /ltx/i;

/** `i`'s caps, or null when it is not a video instance. */
export function capsFromInstance(i: ToolchestInstance): VideoCaps | null {
	if (!i.video) return null;
	const has = (c: string) => i.capabilities.includes(c);
	const ltx = LTX.test(i.recipe) || LTX.test(i.modelSet) || LTX.test(i.id);
	return {
		text: has('text'),
		startImage: has('start_image'),
		endImage: has('end_image'),
		speech: has('audio'),
		// Toolchest's speaking instances are Wan2.2 S2V, which makes nothing without speech.
		needsSpeech: has('audio'),
		sound: ltx,
		limits: i.video,
		frameStep: ltx ? 8 : 4,
		licence: i.licence,
		commercialUse: i.commercialUse
	};
}
