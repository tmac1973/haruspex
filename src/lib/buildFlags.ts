/**
 * Build-time flags, read in one place so every caller spells them the same
 * way and gets a boolean. Vite substitutes them when it builds, so a branch
 * one guards is dropped from a build that doesn't set it.
 *
 * `VITE_HARUSPEX_E2E` is not here on purpose. `src/hooks.client.ts` reads it
 * directly, beside the dynamic import it guards: read through a module like
 * this one, the branch still folds away but the build keeps emitting the
 * drive hooks' chunk (checked with Vite 8), and CI fails a production build
 * that contains it.
 */

/**
 * The web client (`src/web/`, Settings → Remote control's page), which
 * `vite.web.config.ts` builds. It is another computer's browser: no IPC and no
 * custom URI schemes, so media comes from the remote server's HTTP routes.
 */
export const isWebClient: boolean = import.meta.env.VITE_HARUSPEX_WEB === '1';
