---
name: plan-cli-tool
description: Questions and requirements for planning a command-line tool, covering the command shape, arguments, input and output, configuration, errors and exit codes, packaging and testing. Use when the project is a program run from a terminal.
metadata:
  haruspex-job: guided-planning
---

# Planning a command-line tool

A CLI's interface is its command line, its output and its exit codes, and
scripts start depending on them as soon as it ships. They're worth settling
before any code is written.

Settle each topic below that the description hasn't already settled. Offer
the options given, recommended first. Skip topics that clearly don't
apply.

## Questions

### Language
- Python: quick to write, needs Python installed.
- Go or Rust: one binary, nothing to install.
- Node: if it lives with JavaScript tooling.
- Whatever the project already uses.

### Command shape
- One command with options (`tool --flag file`).
- Subcommands (`tool add …`, `tool list`), like git.

Ask for the commands and what each does. Default: a single command unless
there are clearly separate actions.

### Arguments and options
- Which inputs are positional and which are flags.
- Short and long forms (`-o`, `--output`).
- Required options and defaults.
- `--help` and `--version`.

Default: long forms for everything, short forms for the most used, and
`--help` and `--version` always.

### Input
- Files named on the command line.
- Standard input, so it works in a pipe.
- Both, with `-` meaning stdin.
- Interactive prompts. Ask whether these are needed, and how they're
  skipped in scripts.

Default: files and stdin; no prompts unless asked for.

### Output
- Human-readable text.
- JSON with `--json` for scripts.
- Tables, colour, or progress bars.

Also ask whether colour switches off when the output isn't a terminal or
`NO_COLOR` is set, and which output goes to stdout and which to stderr.
Default: plain text, `--json` where scripts would want it, colour only on a
terminal, and messages and progress on stderr.

### Configuration
- None: flags only.
- A config file (where it lives, and its format: TOML, YAML or JSON).
- Environment variables.

Also ask what takes precedence. Default: flags over environment over the
config file.

### Errors and exit codes
- Exit codes: 0 for success, 1 for errors, 2 for bad usage, plus any
  specific to the tool.
- Error message style: one line naming the problem and the fix.
- `--verbose` and `--quiet`.

### Destructive actions
If it deletes or overwrites anything: a confirmation, `--yes` to skip it,
and `--dry-run` to show what would happen.

### Long-running work
Progress output, Ctrl-C handling (clean up and exit), and whether to
resume.

### Packaging
- Run from source.
- Install with the language's package manager (pip, cargo, npm, go
  install).
- Release binaries.

Also ask which platforms: Linux, macOS, Windows.

### Shell completion and a man page
Whether to generate completions (bash, zsh, fish) and a man page.

### Testing
- Unit tests for the logic.
- Tests that run the command and check its output and exit code.
- Both.

Default: both.

## Plan requirements

- The first phase produces a runnable command with `--help` and
  `--version`.
- Every documented option is tested, and `--help` lists it.
- Exit codes are 0 on success and non-zero on failure, and the agreed codes
  are tested.
- Errors go to stderr as one clear line. Data goes to stdout, so piping
  works.
- Any destructive action asks first unless `--yes` is given, or supports
  `--dry-run` as agreed.
- If JSON output is agreed, its shape is documented and tested.
- The verification command runs the tests without network access or a
  terminal.
