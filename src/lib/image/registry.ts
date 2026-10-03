/**
 * Image-backend registry, modeled on the job-type registry: backend modules
 * self-register an `ImageBackend`, and callers resolve one through settings
 * instead of branching on the configured kind.
 *
 * Import `./index.ts` (the registration barrel), not this module, from
 * anything that needs the built-in backends registered.
 */

import type { ImageBackend } from './backend';
import type { ImageBackendKind } from './types';

const backends = new Map<ImageBackendKind, ImageBackend>();

export function registerImageBackend(backend: ImageBackend): void {
	// Replace rather than append: a module-cached barrel may be imported more
	// than once, and a duplicate registration must be idempotent.
	backends.set(backend.kind, backend);
}

export function getImageBackend(kind: ImageBackendKind): ImageBackend | undefined {
	return backends.get(kind);
}

/** All registered backends, in registration order. */
export function listImageBackends(): ImageBackend[] {
	return [...backends.values()];
}
