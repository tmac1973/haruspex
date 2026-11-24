/**
 * At startup, once the named keys are loaded: ask each image and video model
 * no probe has answered for what it can do, so the tools can route without
 * asking every server first.
 */

export async function refreshMissingGenerationCaps(): Promise<void> {
	await Promise.all([
		import('#lib/image/keys.ts')
			.then((m) => m.imageKeysReady())
			.then(() => import('#lib/image/refreshCaps.ts'))
			.then((m) => m.refreshMissingImageCaps())
			.catch((e) => console.warn('Image models were not asked what they can do:', e)),
		import('#lib/videogen/refreshCaps.ts')
			.then((m) => m.refreshMissingVideoCaps())
			.catch((e) => console.warn('Video models were not asked what they can do:', e))
	]);
}
