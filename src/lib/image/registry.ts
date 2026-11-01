/**
 * Image-backend registry, modeled on the job-type registry: each backend kind
 * self-registers a factory that builds an `ImageBackend` for one entry (one
 * model on one server), and callers ask for an entry's backend instead of
 * branching on the configured kind.
 *
 * Import `./index.ts` (the registration barrel), not this module, from
 * anything that needs the built-in backends registered.
 */

import type { GenerateOptions, ImageBackend } from '#lib/image/backend.ts';
import type { ImageBackendKind, ImageModelEntry, ImageResult } from '#lib/image/types.ts';
import { entryConfigKey } from '#lib/generation/entry.ts';
import { legacyEntryFor } from '#lib/image/entries.ts';

type Factory = (entry: ImageModelEntry) => ImageBackend;

/** A factory, or a backend registered as it is (tests, and `none`). */
const kinds = new Map<ImageBackendKind, { factory: Factory; fixed?: ImageBackend }>();

/** Built backends by kind and entry id, with the config they were built from. */
const built = new Map<string, { key: string; backend: ImageBackend }>();

/** Register the factory that builds `kind`'s backend for an entry. */
export function registerImageBackendKind(kind: ImageBackendKind, factory: Factory): void {
	// Replace rather than append: a module-cached barrel may be imported more
	// than once, and a duplicate registration must be idempotent.
	kinds.set(kind, { factory });
	built.clear();
}

/** Register one backend for its kind, used for every entry of that kind. */
export function registerImageBackend(backend: ImageBackend): void {
	kinds.set(backend.kind, { factory: () => backend, fixed: backend });
	built.clear();
}

/** `result` saying which entry made it. */
function tagged(result: ImageResult, entryId: string): ImageResult {
	return { ...result, meta: { ...result.meta, entryId } };
}

/**
 * The backend for `entry`, built once and kept until the entry's address,
 * key, model or options change. Undefined when its kind isn't registered.
 */
export function backendForEntry(entry: ImageModelEntry): ImageBackend | undefined {
	const kind = kinds.get(entry.backend);
	if (!kind) return undefined;
	if (kind.fixed) return kind.fixed;
	const key = entryConfigKey(entry);
	const slot = `${entry.backend} ${entry.id}`;
	const have = built.get(slot);
	if (have?.key === key) return have.backend;
	const inner = kind.factory(entry);
	const own = (opts?: GenerateOptions): GenerateOptions | undefined =>
		opts?.onHandle
			? { ...opts, onHandle: (h) => opts.onHandle!({ ...h, entryId: entry.id }) }
			: opts;
	const backend: ImageBackend = {
		...inner,
		generate: async (req, opts) => tagged(await inner.generate(req, own(opts)), entry.id),
		...(inner.upscale ? { upscale: (input, opts) => inner.upscale!(input, own(opts)) } : {}),
		...(inner.resume
			? {
					resume: async (handle, opts) => tagged(await inner.resume!(handle, opts), entry.id)
				}
			: {})
	};
	built.set(slot, { key, backend });
	return backend;
}

/**
 * `kind`'s backend as Settings → Image's fields for that kind describe it,
 * whichever kind is chosen.
 */
export function getImageBackend(kind: ImageBackendKind): ImageBackend | undefined {
	if (kind === 'none') return kinds.get('none')?.fixed;
	return backendForEntry(legacyEntryFor(kind));
}

/** Each registered kind's backend, in registration order. */
export function listImageBackends(): ImageBackend[] {
	return [...kinds.keys()].map((k) => getImageBackend(k)).filter((b) => b !== undefined);
}

/**
 * `kind`'s backend as Settings → Image's fields for that kind describe it, read
 * again on every call: for callers (and tests) that hold one backend per kind.
 */
export function legacyBackend(kind: Exclude<ImageBackendKind, 'none'>): ImageBackend {
	const now = (): ImageBackend => {
		const b = getImageBackend(kind);
		if (!b) throw new Error(`No ${kind} image backend is registered.`);
		return b;
	};
	const missing = (what: string) => new Error(`The ${kind} image backend can't ${what}.`);
	return {
		kind,
		capabilities: () => now().capabilities(),
		probe: () => now().probe(),
		generate: (req, opts) => now().generate(req, opts),
		upscale: (input, opts) => {
			const b = now();
			if (!b.upscale) throw missing('upscale');
			return b.upscale(input, opts);
		},
		resume: (handle, opts) => {
			const b = now();
			if (!b.resume) throw missing('resume a job');
			return b.resume(handle, opts);
		}
	};
}
