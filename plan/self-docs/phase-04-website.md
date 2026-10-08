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

## Decisions made while building it

- **Pages live at `/guide/<name>/`, with `getting-started` at `/guide/`.**
  The page list across the top follows getting-started's "Where to go
  next" list, the guide's own reading order.
- **Two kinds of reference become links:** "the `skills` page", and a list
  item that starts with a page name, as getting-started's list does. A
  reference to a page that doesn't exist fails the build, and so CI.
- **No separate template file.** The page shell sits in the script, using
  the site's header, footer and colours plus a few guide styles appended to
  `site/style.css`. The footer has an "Edit this page" link to the Markdown
  on GitHub.
- **The Pages deploy now runs `npm ci --ignore-scripts`** to get `marked`.
  If it ever fails, the previous deploy (home, privacy, terms) stays up.
- **The README links the guide** in one line at the top. Its feature
  sections stay for now; trimming them to links is a separate decision.
