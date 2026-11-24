/**
 * Video model entries for tests: what Settings → Video generation keeps in
 * `videoModels`, with everything a test doesn't name left blank.
 *
 *   updateSettings({ videoModels: [videoModel('llama-toolchest', { model: 'ltx' })] });
 *
 * (Inside `vi.hoisted`, import it with `await import('#lib/testing/videoModels.ts')`.)
 */
import type { VideoCaps, VideoModelEntry } from '#lib/videogen/types.ts';
import { defaultVideoName } from '#lib/videogen/fields.ts';

type Kind = VideoModelEntry['backend'];

/** One entry on `backend`; its id is `test-<backend>` unless `fill` names one. */
export function videoModel(
	backend: Kind,
	fill: Partial<Omit<VideoModelEntry, 'backend'>> = {}
): VideoModelEntry {
	const model = fill.model ?? '';
	return {
		id: `test-${backend}`,
		name: defaultVideoName({ backend, model }),
		url: '',
		keyId: null,
		options: {},
		caps: null,
		capsAt: null,
		renamed: false,
		...fill,
		backend,
		model
	};
}

/** Caps for a Wan-like model that does a prompt or a start image; `over` changes any. */
export function videoCaps(over: Partial<VideoCaps> = {}): VideoCaps {
	return {
		text: true,
		startImage: true,
		endImage: false,
		speech: false,
		needsSpeech: false,
		sound: false,
		limits: {
			defaultFps: 24,
			defaultFrames: 121,
			defaultSize: '1280x704',
			maxFrames: 121,
			maxSize: null,
			maxPixelFrames: null,
			fixedFps: null
		},
		frameStep: 4,
		licence: '',
		commercialUse: null,
		...over
	};
}
