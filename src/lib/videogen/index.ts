/**
 * Registers every video backend. Import this, not `./registry.ts`, from
 * anything that builds a backend from an entry.
 */

import '#lib/videogen/toolchest/backend.ts';

export { videoBackendForEntry, videoBackendKinds } from '#lib/videogen/registry.ts';
