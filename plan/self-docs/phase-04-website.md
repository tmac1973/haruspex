# Phase 4 — The guide on the website

## Goal

`tmac1973.github.io/haruspex/guide/` shows the same pages as the app, built
from the same Markdown.

## Work

- **A build script** (`scripts/build-guide.mjs`):
  - Render `docs/guide/*.md` to HTML with `marked`, into `site/guide/<name>/`.
  - One shared page template: the site's stylesheet, a sidebar listing the
    pages by title, and the page's description as its meta description.
  - `site/guide/index.html` is `getting-started` with the full page list.
  - Links between pages (written as page names) become relative links.
- **`pages.yml`**:
  - Also trigger on `docs/guide/**` and the script.
  - Run `npm ci` and the script before uploading `site/`.
  - Keep the generated `site/guide/` out of git (gitignored), so the
    Markdown is the only source.
- **The home page** links to the guide, and the README's feature list links
  to the published pages.

## Tests

- The script runs in CI (the `frontend` job) and fails on a page that
  doesn't render or a link to a page that doesn't exist.
- A snapshot of one rendered page catches template breakage.

## Done when

The guide is live on the site, every page is reachable from the sidebar,
and editing a page in a PR publishes it when the PR merges.
