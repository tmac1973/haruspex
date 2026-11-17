/**
 * Whether Settings offers Other computers (plan/instance-sync/) yet: in a dev
 * build and the e2e build, not a release, until the whole feature lands.
 *
 * Reads the e2e flag itself and imports nothing from `src/lib/e2e`, for the
 * reason `src/lib/buildFlags.ts` gives: no e2e chunk in a production build.
 */
export const PEERS_READY: boolean =
	import.meta.env.DEV || import.meta.env.VITE_HARUSPEX_E2E === '1';
