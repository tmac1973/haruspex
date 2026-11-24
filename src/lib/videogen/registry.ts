/**
 * Video-backend registry: each backend kind registers a factory that builds a
 * `VideoBackend` for one entry (one model on one server), and callers ask for
 * an entry's backend instead of branching on its kind.
 *
 * Import `./index.ts` (the registration barrel), not this module, from
 * anything that needs the built-in backends registered.
 */

import type { VideoBackend } from '#lib/videogen/backend.ts';
import type {
	VideoBackendKind,
	VideoGenerateOptions,
	VideoModelEntry
} from '#lib/videogen/types.ts';
import { entryConfigKey } from '#lib/generation/entry.ts';

type Factory = (entry: VideoModelEntry) => VideoBackend;

const kinds = new Map<VideoBackendKind, Factory>();

/** Built backends by kind and entry id, with the config they were built from. */
const built = new Map<string, { key: string; backend: VideoBackend }>();

/** Register the factory that builds `kind`'s backend for an entry. */
export function registerVideoBackendKind(kind: VideoBackendKind, factory: Factory): void {
	kinds.set(kind, factory);
	built.clear();
}

/** Whether `kind` has a backend: the kinds Settings may offer. */
export function videoBackendKinds(): VideoBackendKind[] {
	return [...kinds.keys()];
}

/**
 * The backend for `entry`, built once and kept until the entry's address,
 * key, model or options change. Every handle it reports names the entry.
 * Undefined when its kind isn't registered.
 */
export function videoBackendForEntry(entry: VideoModelEntry): VideoBackend | undefined {
	const factory = kinds.get(entry.backend);
	if (!factory) return undefined;
	const key = entryConfigKey(entry);
	const slot = `${entry.backend} ${entry.id}`;
	const have = built.get(slot);
	if (have?.key === key) return have.backend;
	const inner = factory(entry);
	const own = (opts?: VideoGenerateOptions): VideoGenerateOptions | undefined =>
		opts?.onHandle
			? { ...opts, onHandle: (h) => opts.onHandle!({ ...h, entryId: entry.id }) }
			: opts;
	const backend: VideoBackend = {
		...inner,
		generate: (req, opts) => inner.generate(req, own(opts)),
		resume: (handle, req, opts) => inner.resume(handle, req, own(opts))
	};
	built.set(slot, { key, backend });
	return backend;
}
