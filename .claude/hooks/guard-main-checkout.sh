#!/bin/bash
# PreToolUse hook: refuse `git checkout`, `git switch` and `git pull` in the
# main checkout. `tauri dev` runs from it and hot-reloads whatever changes
# there, so a session that moves files in it reloads (or rebuilds) the
# running app. Linked worktrees (.claude/worktrees/*, ../haruspex-*) are fine.
#
# The command is split on && || ; | and newlines, and `cd DIR` / `git -C DIR`
# are followed to find which checkout each git command runs in.

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
dir=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cmd" ] || exit 0
[ -n "$dir" ] || dir=$PWD

# Resolve a path the way the shell would from $1.
resolve() {
    local base=$1 p=$2
    p=${p%\"}; p=${p#\"}; p=${p%\'}; p=${p#\'}
    case $p in
        '~') p=$HOME ;;
        '~/'*) p=$HOME/${p#'~/'} ;;
        /*) ;;
        *) p=$base/$p ;;
    esac
    (cd "$p" 2>/dev/null && pwd -P) || echo "$p"
}

# True when $1 is inside a primary checkout rather than a linked worktree.
is_main_checkout() {
    local git_dir common_dir
    git_dir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
    common_dir=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
        return 1
    [ "$git_dir" = "$common_dir" ]
}

segments=$(sed -E 's/(&&|\|\||;|\|)/\n/g' <<<"$cmd")
while IFS= read -r seg; do
    read -ra words <<<"$seg"
    [ ${#words[@]} -gt 0 ] || continue
    if [ "${words[0]}" = cd ] && [ -n "${words[1]}" ]; then
        dir=$(resolve "$dir" "${words[1]}")
        continue
    fi
    [ "${words[0]}" = git ] || continue
    target=$dir
    sub=
    i=1
    while [ $i -lt ${#words[@]} ]; do
        w=${words[$i]}
        case $w in
            -C) i=$((i + 1)); target=$(resolve "$target" "${words[$i]}") ;;
            -c) i=$((i + 1)) ;;
            -*) ;;
            *) sub=$w; break ;;
        esac
        i=$((i + 1))
    done
    case $sub in
        checkout | switch | pull) ;;
        *) continue ;;
    esac
    if is_main_checkout "$target"; then
        top=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)
        echo "Refused: \`git $sub\` in the main checkout ($top). The dev app runs from it" \
            "and reloads when its files change. Work in a worktree instead" \
            "(git worktree add .claude/worktrees/<name> -b <branch>)." >&2
        exit 2
    fi
done <<<"$segments"
exit 0
