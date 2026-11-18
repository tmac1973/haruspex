# Phase 06 — Guide pages and PR

**Depends on:** 01–05 · **Enables:** release

## Goal
Describe the feature in the user guide, file what's left as an issue, and
open the single PR for the branch.

## Files touched
- `docs/guide/web-preview.md` — new page, under 6 KB, `title` and
  `description` frontmatter.
- `docs/guide/helpers.md` — "Turn a helper on": "all off" becomes "all off
  except Web preview"; a new two-sentence `## The Web preview helper` section
  before "What it doesn't do" that names `show_preview` and points at the
  `web-preview` page. It is 5,645 bytes now; if the edit takes it past 6 KB,
  shorten the 3D helper section's prose (its details live on the
  `3d-helper` page).
- `docs/guide/code.md` — one sentence in its tools list naming the preview
  window and pointing at the `web-preview` page; it is 5,995 bytes, so cut an
  equal number of words from the same section to stay under 6 KB.

## Steps
1. `web-preview.md` sections, headings phrased as what the user wants to do:
   - **See a page the agent made**: `show_preview` opens it in a window that
     reloads when the page's files change; one window per session.
   - **Open a preview yourself**: the Preview button beside `.html` files.
   - **Check a page at phone or tablet width**: the toolbar presets.
   - **Let the agent see the page**: install Browser (Playwright) from
     Settings → MCP servers → Add from the catalog (see the `integrations`
     page); the agent opens the address `show_preview` returns and takes
     screenshots of it.
   - **Turn it off**: Settings → Code → Helpers → Web preview, or the
     session's **Extras** menu, which lists every helper already.
   - **What it doesn't do**: no dev servers, no build step, nothing outside
     the session folder, no dotfiles, not for sessions on another computer or
     in WSL, not viewable from the remote web client; the address works only
     on this computer while the window is open.
2. Write compact tables only, and don't run Prettier on `docs/guide/`.
3. `node scripts/guide-check.mjs < /dev/null` passes.
4. File one GitHub issue, "Web preview follow-ups", with a checklist: dev
   server URLs; WSL folders; sessions on another computer; previews from the
   remote web client; packaged
   build check of the IPC isolation and CSP `frame-src` on Linux, Windows and
   macOS.
5. Open the PR (title
   `feat(code): web preview window for mockups the agent writes`), body naming
   `docs/guide/web-preview.md`, `docs/guide/helpers.md` and
   `docs/guide/code.md` and linking the
   issue; add the `windows-ci` label with a separate `gh pr edit` and push
   once more so Windows CI runs the path tests.

## Build gate
- `npm run check && npm run lint && npm run test && npm run format:check`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- The shortcuts and guide-size tests pass.
- Ask the app "how do I preview a web page in Code?" and check it answers from
  `web-preview` via `haruspex_docs`.

## Commit
`docs(guide): web preview page and helper default`

## Rollback
Revert the docs commit together with the feature commits; docs alone
reverted would fail the Guide check on the PR.
