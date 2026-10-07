# Phase 1 — Finding and parsing skills

## Goal

A Rust module that finds every skill the user has, parses and validates it to
the spec, and serves it to the frontend. Nothing in a turn changes yet.

## Work

- `src-tauri/src/skills/` (new):
  - `parse.rs`: split the frontmatter from the body; parse YAML with a
    maintained crate (`serde_yaml` is deprecated — pick a maintained fork
    and check its licence).
  - Validate leniently, per the agentskills.io client guide:
    - **Skip** (listed in Settings with the error): no `description`, or YAML
      that can't be parsed even after the retry below.
    - **Warn and load**: a `name` that doesn't match its folder, breaks the
      character rules (lowercase letters, digits, hyphens; no leading,
      trailing or doubled hyphen) or exceeds 64 characters; a `description`
      over 1024 or `compatibility` over 500 characters.
    - **Retry**: a top-level value containing an unquoted `: ` is re-quoted and
      parsed again, the common invalid-YAML case in skills from other clients.
    - `license`, `compatibility`, `metadata` (string → string) and
      `allowed-tools` (space-separated) are read and kept; unknown fields are
      ignored.
    - When `name` is missing, the folder name is used, with a warning.
  - `discover.rs`: walk each source (built-in, `<app data>/skills/`,
    `~/.agents/skills/`, extra folders from settings, and — when given a
    trusted project root — `.agents/skills/` and `.claude/skills/` under it).
    One level deep: `<source>/<name>/SKILL.md`. Skip symlinks that leave the
    source folder.
  - Precedence, lowest first: built-in < extra folders < `~/.agents/skills/`
    < `<app data>/skills/` < project. Project overrides user, per the
    convention; Haruspex's own folder overrides folders shared with other
    tools. The overridden entry is kept in the list, marked as shadowed.
  - Read the body at activation, not at discovery, so an edit to a skill is
    picked up without a restart.
- Tauri commands:
  - `skills_list(project_root: Option<String>) -> Vec<SkillSummary>`: name,
    description, source, path, error (if invalid), shadowed, written-by-model
    (from `metadata`).
  - `skill_read(name, project_root) -> SkillDoc`: the body, plus a list of the
    files under the skill's folder (relative paths, capped at 200).
  - `skill_read_file(name, project_root, rel_path) -> String`: one file from
    inside the skill's folder. Refuses `..`, absolute paths and anything that
    resolves outside the folder. Size-capped like `fs_read_text`.
- `#[ts(export)]` the structs and run `./scripts/export-ipc-types.sh`.
- Settings: `skills: { extraDirs: string[], disabled: string[], autonomous:
'auto' | 'on' | 'off', trustedRepos: Record<string, boolean> }` with
  defaults. `auto` resolves to on for remote and OpenRouter backends and off
  for local.

## Tests

- Parsing: valid skill; each skip and each warning; the colon retry; CRLF
  line endings; a BOM; frontmatter with no closing `---`; unknown fields kept
  out of errors.
- Discovery: precedence (project over user) and shadowing; an untrusted
  project root contributes nothing; a broken skill listed with its error;
  a symlink pointing out of the source is skipped.
- `skill_read_file` refuses traversal (`../`, absolute, symlink escape).

## Done when

`skills_list` returns the right set for a temp directory tree covering every
source, and all of the above tests pass.
