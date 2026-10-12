---
name: code-audit
description: Audit a codebase for consistency, duplication, logging, secrets, test quality and dependency health, then report checked findings by severity with a suggested fix order. Use when the user runs /code-audit or asks for a code quality review, audit or health check of a repo or folder.
metadata:
  haruspex-mode: code
---

# Audit the code

Find real problems, check each one against the source, and report them by
severity. Read and run checks only: never edit code during the audit.

## 1. Scope and context

- If the user named a folder or file, audit only that. Otherwise audit the
  whole project, skipping generated and vendored folders (`node_modules`,
  `dist`, `build`, `target`, `vendor`, `.git` and the like).
- If the project is large (hundreds of source files) and no scope was given,
  ask with `ask_user_question` which part to audit first, offering the main
  source folders and "the whole project".
- Read the manifests (`package.json`, `Cargo.toml`, `pyproject.toml`,
  `go.mod`, …), lint and format config, and `AGENTS.md` or `CLAUDE.md`. Note
  the languages, frameworks, test setup, and the project's own rules. Judge
  the code by the project's rules, not general taste: what a linter already
  enforces isn't a finding.

## 2. Work through the categories

Go through the six categories below one at a time, using `code_glob`,
`code_grep` and `fs_read_text`. Keep at most 8 findings per category, the most
serious first. Note each one as: severity (high, medium or low), one line
saying what's wrong, and `file:line`.

**Consistency.** Code that breaks the project's own conventions: naming,
module layout, error handling (one function throws, its neighbour returns
null, a third swallows the error), mixed async styles for the same job.

**Duplication.** Functions in different files doing the same thing, copied
blocks of several lines that belong in one helper, the same magic string or
number in several places. Source only, not tests.

**Logging and leftovers.** Logging that breaks the project's own logging rules,
debug output and commented-out code left behind, and anything that could log
a token, password, key or personal data. Using `console` or `print` is only a
finding when the project says not to.

**Secrets.** Hard-coded keys, tokens, passwords or credentials in URLs;
`.env`, key or credential files tracked by git (`git ls-files` through
`run_command`); `.gitignore` missing such files; secrets that reach error
messages, responses or logs; environment variables read all over the code
instead of through one checked config.

**Tests.** The riskiest source files with no tests (not a list of every one),
tests that assert nothing meaningful or only test their mocks, tests tied to
internals or exact formatting, functions tested only on the happy path, and
setup copied across test files.

**Dependencies.** For each ecosystem present, run its checks with
`run_command`, where installed:

| Ecosystem | Vulnerabilities | Outdated | Lockfile |
|---|---|---|---|
| Node | `npm audit --json` | `npm outdated --json` | `package-lock.json` (or pnpm/yarn's) tracked |
| Python | `pip-audit -f json` | `pip list --outdated --format=json` | `uv.lock`, `poetry.lock` or pinned requirements tracked |
| Rust | `cargo audit --json` | `cargo outdated --root-deps-only` | `Cargo.lock` tracked |
| Go | `govulncheck ./...` | `go list -m -u all` | `go.sum` tracked |

Critical or high vulnerabilities are high; moderate ones are medium. Two or
more major versions behind is medium, anything less is low, and development
dependencies are never above low. Ignore pre-releases. When a tool isn't
installed or can't reach the network, record one low finding saying which
check didn't run, and move on. Don't install anything.

## 3. Check every finding

Before reporting a finding, read the cited lines again with `fs_read_text`.
Drop it if the code doesn't say what the finding claims, and fix the line
number if it moved. Merge findings that are the same problem seen from two
categories. A short report that's right is worth more than a long one that
isn't.

## 4. Report

```markdown
# Code audit

**Project:** <languages and frameworks> · **Scope:** <whole project or path>
**Findings:** <N> (<H> high, <M> medium, <L> low)

## High
### <Category>
- <what's wrong> — `file:line`

## Medium
…

## Low
…

## Not checked
- <checks that couldn't run, and why>

## Fix order
1. <group of findings>: <why first — e.g. security, or shared code others depend on>
2. …
```

Leave out empty sections. Dependency findings cite `package@version (current
→ latest)` instead of a line.

Then offer, in one or two sentences: to save the report to a file, to fix the
small items now, and for larger work, to plan it with `/guided-planning`. Say
that Jobs → Audit runs an audit several times and checks each finding
independently, for results that matter more.
