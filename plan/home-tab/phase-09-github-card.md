# Phase 09 — GitHub card

**Depends on:** 01, 02, 03, 05, 07, 08 · **Enables:** nothing further

## Goal
A fetched card that watches GitHub for work that needs you. By default it
shows open issues on your repos that someone else filed and you have not
commented on. Presets also cover pull requests waiting for your review and
pull requests from others. All data comes from the GitHub MCP server in the
catalog (`github-mcp-server` v1.12.0), called directly through
`mcp_call_tool` with no model, so the card needs no GitHub integration and no
token handling of its own. Each item can open in the browser, go to Ask about
this, or start work in your local checkout, as a code session with the issue
as a draft first message or as a guided-planning job.

Upstream facts this design rests on, from the v1.12.0 source:
- `search_issues` runs GitHub's semantic search on github.com (lexical only
  on GHES), which ranks by meaning and does not honour negated qualifiers
  reliably. The card does not use it.
- `search_pull_requests` runs lexical search with full qualifier syntax and
  prefixes `is:pr` when the query has none.
- `list_issues` takes `owner`, `repo`, `state`, `labels`, `since`, `orderBy`,
  `direction`, `perPage` and `after`; `issue_read` takes `owner`, `repo`,
  `issue_number` and `method` (`get`, `get_comments`, …); `get_me` returns
  the token owner's profile; `search_repositories` takes a `query`.
- The catalog's `defaultTools` limit only what the model is shown
  (`registerMcpTools`); `mcp_call_tool` calls any tool the server lists.

## Files touched
- `src/lib/home/github.ts` (new) — server lookup, repo resolution, the three
  fetchers and the parsers.
- `src/lib/home/github.fixtures.ts` (new) — recorded v1.12.0 replies for
  `get_me`, `search_repositories`, `list_issues`, `issue_read` (`get` and
  `get_comments`) and `search_pull_requests`, with the version they came
  from.
- `src/lib/home/cardTypes.ts` — `github` entry (step 9), and a new optional
  registry hook `title(config)`; `CardFrame.svelte` and `engine/home.ts`
  use it, falling back to the type's `label` (judged cards keep their job
  name).
- `src/lib/components/home/CardFrame.svelte` — title from the hook.
- `src/lib/home/fetchedCards.svelte.ts` — honour a fetch's `skip` result
  (step 2); call `notifyNewItems` after a successful fetch.
- `src/lib/home/notifyNewItems.ts` — new signature (step 10).
- `src/lib/stores/homeCards.svelte.ts` — the phase-03 judged-run caller
  passes `result_json.items` in the new signature.
- `src/lib/home/askAbout.ts` — a GitHub item format.
- `src/lib/components/home/ItemActions.svelte` — Work on this entries for
  GitHub issue rows.
- `src/lib/components/home/cards/GitHubCard.svelte` (new).
- `src/lib/components/home/forms/GitHubForm.svelte` (new).
- `src/lib/home/workOnIssue.ts` (new).
- `src/lib/stores/code.svelte.ts` — a pending input draft per code session.
- `src/lib/components/code/CodeComposer.svelte` — takes the session's
  pending draft into its input (step 13) and focuses it.
- `src/lib/stores/jobsTabSelection.svelte.ts` — `newJobDraft(draft)`.
- `src/lib/components/jobs/JobsTab.svelte`, `JobEditor.svelte` — optional
  `draft` prop for a new job (step 13).
- `src-tauri/src/code_tools/checkout.rs` (new) — `code_find_checkout`.
- `src-tauri/src/code_tools/mod.rs` — declare `checkout`.
- `src-tauri/src/skills/mod.rs` — `mod origin;` becomes `pub(crate) mod
  origin;` so `origin_url` can be reused; no behaviour change.
- `src-tauri/src/lib.rs` — register `code_find_checkout`.
- `src/lib/ipc/gen/*` — regenerated.
- `src/lib/engine/home.ts` — the `github` payload.
- `src/web/home/GitHubCard.svelte` (new), and `src/web/home/HomeView.svelte`
  from phase 08 — add the `github` case.
- `docs/guide/home.md`, `docs/guide/integrations.md`,
  `docs/guide/remote-control.md`.

## Steps
1. Server lookup: `githubServer()` returns the first configured MCP server
   whose `source` is `{ kind: 'catalog', entryId: 'github' }`
   (`McpServerSource`), with its runtime state from `mcpState(id)` in
   `stores/mcpServers.svelte.ts`. The card type is `addable` when such a
   server is configured, enabled or not.
2. Notice states: the card type's `fetch(config)` first checks the server.
   It returns `{ skip: 'Add GitHub in Settings → Integrations → MCP.' }` when
   none is configured, `{ skip: 'Turn on GitHub in Settings → Integrations
   → MCP.' }` when it is disabled, and `{ skip: 'Start GitHub in Settings →
   Integrations → MCP.' }` when it is not running. The refresher treats a
   `skip` result as neither success nor failure: it keeps `last_result` and
   `updated_at`, and the card shows the notice above the cached items. Other
   card types never return `skip`.
3. Card config: `{ preset: 'issues_from_others' | 'prs_to_review' |
   'prs_from_others'; owners: string[]; repos: string[]; unanswered:
   boolean (default true); excludeBots: boolean (default true);
   labelsInclude: string[]; labelsExclude: string[]; days: number
   (default 30); max: number (default 15) }`. `owners` and `repos` both
   empty means "my repos".
4. Login: `get_me` once per fetch gives `login`. All "me" checks compare
   with it, case-insensitively.
5. Repo resolution (issues preset): every `repos` entry is always kept. For
   each entry in `owners` (or `[login]` when both lists are empty), call
   `search_repositories` with `query: 'user:<owner> archived:false
   sort:updated'`, `perPage: 30`; these results come back newest first.
   Owner repos not already listed fill the remaining slots, newest first,
   up to 30 repos in all. The resolved list is
   cached in memory for an hour so a refresh costs only issue calls.
6. Issues fetcher (`issues_from_others`): for each repo, `list_issues` with
   `state: 'OPEN'`, `since: <now − days, ISO 8601>`, `labels:
   labelsInclude` when non-empty, `orderBy: 'UPDATED_AT'`, `direction:
   'DESC'`, `perPage: 50`. The app then keeps an issue when:
   - its author is not `login`;
   - with `excludeBots`, its author login does not end in `[bot]` and its
     author type is not `Bot`;
   - it has none of `labelsExclude`;
   - it is not a pull request.
   Sort all repos' issues by `updated_at` descending. With `unanswered`,
   walk that list and call `issue_read` with `method: 'get_comments'` for
   each, dropping issues with a comment by `login`, until `max` issues are
   kept; issues with zero comments skip the call. Without `unanswered`,
   take the first `max`.
7. Pull request fetchers: one `search_pull_requests` call with a query built
   from `is:open`, the scope (`repo:<o>/<n>` per `repos`, `user:<owner>` per
   `owners`, `user:<login>` when both are empty), `sort:updated-desc`,
   `label:"<l>"` per include label, `-label:"<l>"` per exclude label, and
   `updated:>=<YYYY-MM-DD>` from `days`; `prs_to_review` adds
   `review-requested:<login>` and ignores `excludeBots` and `unanswered`
   (the form hides both for that preset); `prs_from_others` adds `-author:<login>`,
   plus `-author:app/dependabot -author:app/renovate` with `excludeBots`, and
   `-commenter:<login>` with `unanswered`. `perPage: max`.
8. Item shape, from the tool's JSON text content: `{ id, repo, number,
   title, url, author, labels, comments, updatedAt, isPr }`. `id` is the
   item's `node_id`, and `html_url` only when `node_id` is absent, so ids
   stay the same across fetches. `repo` is `owner/name` from
   `repository_url` (or the repo the call was made for). The parsers live
   in `github.ts` and are tested against the fixtures. A tool reply whose
   outcome is not `complete` (the server asking for input) is a fetch error:
   "GitHub asked for input; open it from a chat instead."
9. Registry entry: `kind: 'fetched'`, `notifies: true`,
   `fetch: fetchGitHub`, `intervalMinutes: () => 15`, `itemLabel: (i) =>
   i.repo + '#' + i.number + ' ' + i.title`, `title: (config) =>` the
   preset's name ("Issues from others", "Reviews requested", "Pull requests
   from others"). Titles are not editable; two GitHub cards with the same
   preset are told apart by the scope line under the title (owners and
   repos, or "My repos").
10. `notifyNewItems(card, prevItems, nextItems)` replaces phase 03's
    `(card, prevResult, nextResult)`: both arguments are now arrays of items
    with an `id`. The phase-03 caller in `homeCards.svelte.ts` passes
    `prevResult?.items` and `nextResult.items`; `fetchedCards` passes the old
    and new `last_result.items` for cards with `notify` on. No notification
    when `prevItems` is undefined (the first result).
11. Card: rows show `repo#number`, title (opens `url`), author, label chips,
    comment count and age. Empty state per preset: "No open issues from
    others.", "No reviews requested.", "No open pull requests from others."
    Ask about this formats `repo#number`, title, author, labels and `url`
    (the body is not fetched; the chat can read it with the GitHub tools).
12. `code_find_checkout(repo: String, roots: Vec<String>) -> Option<String>`:
    for each root, read `skills::origin::origin_url`, normalise it
    (`git@github.com:o/n.git`, `https://github.com/o/n(.git)`,
    `ssh://git@github.com/o/n` → `o/n`, compared case-insensitively) and
    return the first match. Roots are each saved code session's `root` from
    `listCodeSessions()` in `src/lib/code/db.ts`, newest first, without
    duplicates.
13. Work on this, on issue rows only, in the `ItemActions` menu:
    - Both actions find the checkout first. With none: toast "No local
      checkout of owner/name found. Open it once in the Code tab." Then
      `issue_read` with `{ owner, repo, issue_number: number, method:
      'get' }` for the body; if that call fails, toast "Couldn't read
      owner/name#N from GitHub." and stop.
    - **Open code session**: `openCodeSessionAt(root)` from
      `stores/code.svelte.ts` creates a new session there, switches to the
      Code tab and returns the `CodeSession`; set that session's pending
      draft (by its `id`) to "Work on owner/name#N: <title>\n\n<body>\n\n
      <url>". `CodeComposer` takes a pending draft for its session on mount
      and whenever the pending draft for its session changes, so an already
      mounted composer picks it up too; the draft is unsent.
    - **Plan this issue**: `newJobDraft({ jobType: 'guided_planning', name:
      'owner/name#N', workingDir: root, config: {
      ...getJobType('guided_planning').configDefaults(),
      initial_description: <title, body and url> } })`, then
      `setActiveTab('jobs')`. `JobsTab` sets `selectedId = 'new'` and passes
      the draft to `JobEditor`, which uses it in place of the blank new-job
      state and opens the type section; nothing is saved until the user
      saves. Autonomous coding is not offered directly because it starts
      from a plan folder; guided planning can chain into a coding run.
    - `jobsTabSelection` holds at most one pending item, either a
      `selectJob` or a `newJobDraft`; setting one replaces the other.
14. Add card form (`GitHubForm.svelte`): preset (radio); Owners and Repos
    as comma-separated text fields ("tmac1973, my-org"; "owner/name, …"),
    each entry checked against `^[\w.-]+$` and `^[\w.-]+/[\w.-]+$`;
    Unanswered only and Hide bots checkboxes (hidden for Reviews requested);
    include and exclude labels as comma-separated fields; days and max as
    numbers (1–365, 1–50). Submit calls `addCard('github', config)`; the
    button is disabled while an entry is invalid, with the bad entry named
    under its field.
15. Remote control: `engine/home.ts` returns the `github` items as stored;
    the web renderer shows rows whose links open in the phone's browser. No
    Work on this from the phone.
16. Docs: `home.md` (the card, presets, filters, the MCP server it needs,
    Work on this); `integrations.md` (the GitHub MCP server also feeds the
    Home card, and the token's repo access limits what it sees);
    `remote-control.md` (read-only on the phone).

## Build gate
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`
- `npm run build:web`
- `cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff
- `node scripts/guide-check.mjs` passes

## Test plan
- Unit: parsers against every fixture; a test reads the catalog's `github`
  version and fails when it differs from the fixtures' version, so a bump
  re-records them.
- Unit: issues fetcher with a fake `mcp_call_tool` — own issues, bot
  authors, excluded labels and pull requests are dropped; `unanswered`
  drops an issue with your comment and stops calling `issue_read` once
  `max` are kept; zero-comment issues make no `issue_read` call.
- Unit: PR query builder for both presets, empty and filled scopes, labels
  with spaces, the `days` date.
- Unit: server lookup and `skip` — none, disabled, stopped, running; a skip
  keeps the cached items and `updated_at`.
- Unit: `notifyNewItems` — first result silent; a new id notifies with
  `itemLabel`; the judged-run path still works.
- Component: `JobEditor` with a `draft` shows the type, name, working
  directory and description, unsaved; `jobsTabSelection` keeps only the last
  pending item.
- Rust: `code_find_checkout` with SSH, HTTPS, `.git`-suffixed and
  mixed-case remotes, a worktree root, and no match.
- Hand: with the catalog GitHub server set up, add the card; file an issue on
  one of your repos from a second account; Refresh; it appears; comment on
  it from your account; Refresh; it drops off. Stop the server; the notice
  shows over the cached rows. Open code session on an issue in a repo you
  have opened before; the draft is in the input, unsent.

## Commit
`feat(home): GitHub card fed by the catalog's GitHub MCP server`

## Rollback
Revert the commit. `github` cards show "Unknown card" through the phase-01
guard. `notifyNewItems` returns to the phase-03 signature with the revert.
The MCP server and its settings are untouched.
