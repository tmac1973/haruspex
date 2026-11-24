/**
 * Image model entries for tests: what Settings → Image keeps in
 * `imageModels`, with everything a test doesn't name left blank.
 *
 *   updateSettings({ imageModels: [imageModel('comfyui', { url: 'http://box:8188' })] });
 *   const settings = vi.hoisted(() => ({ imageModels: imageModelsFor('local') }));
 *
 * (Inside `vi.hoisted`, import it with `await import('#lib/testing/imageModels.ts')`.)
 */
import type { ImageModelEntry } from '#lib/image/types.ts';
import { defaultImageName } from '#lib/image/fields.ts';

type Kind = ImageModelEntry['backend'];

/** One entry on `backend`; its id is `test-<backend>` unless `fill` names one. */
export function imageModel(
	backend: Kind,
	fill: Partial<Omit<ImageModelEntry, 'backend'>> = {}
): ImageModelEntry {
	const model = fill.model ?? '';
	return {
		id: `test-${backend}`,
		name: defaultImageName({ backend, model }),
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

/** The list for one backend, or none for `'none'`: what a test that only picks a kind wants. */
export function imageModelsFor(
	kind: Kind | 'none',
	fill: Partial<Omit<ImageModelEntry, 'backend'>> = {}
): ImageModelEntry[] {
	return kind === 'none' ? [] : [imageModel(kind, fill)];
}
