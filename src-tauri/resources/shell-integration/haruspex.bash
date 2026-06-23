# Haruspex shell integration for bash.
# Sourced after the user's normal startup files. Emits OSC 133 prompt
# markers (A=prompt start, B=prompt end, C=command output start,
# D=command end + exit code) and OSC 7 cwd updates so the host app can
# locate the last command and its output in the byte stream.

if [[ -n "${__HSP_INTEGRATION_LOADED:-}" ]]; then
    return 0
fi
__HSP_INTEGRATION_LOADED=1

# Flag set by preexec, cleared by precmd. Used by precmd to know
# whether a real user command actually ran (vs an empty Enter on a
# prompt, where DEBUG doesn't fire).
__hsp_in_command=""
__hsp_last_status=0

# "At an interactive prompt, waiting for the user's next command." Armed as the
# LAST entry in PROMPT_COMMAND (see __hsp_arm) — i.e. only after every other
# precmd hook has run — and disarmed the instant the user's command starts (and
# again at the top of our own precmd). The DEBUG trap ignores everything while
# this is empty, which is what stops us from emitting a spurious command-output
# (C) marker for the precmd hooks of *other* shell integrations that also live
# in PROMPT_COMMAND. The one that bit us in practice: systemd's
# __systemd_osc_context_precmdline (OSC 3008) on Fedora, whose DEBUG firing was
# captured as a never-ending "command", making run_command think the terminal
# was perpetually busy.
__hsp_at_prompt=""

__hsp_prompt_start()  { printf '\033]133;A\007'; }
__hsp_prompt_end()    { printf '\033]133;B\007'; }
__hsp_command_done()  { printf '\033]133;D;%s\007' "$__hsp_last_status"; }
__hsp_emit_cwd()      { printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }

# Emit the C marker. If a command line was captured (from BASH_COMMAND
# in DEBUG), embed it base64-encoded as a `cl=` attribute so the host
# doesn't have to reconstruct it from the terminal echo (which loses
# fidelity to readline edits: backspace, history navigation, inline
# autosuggestions, etc.).
__hsp_output_start() {
    local cmd=$1
    if [[ -n "$cmd" ]] && command -v base64 >/dev/null 2>&1; then
        local b64
        b64=$(printf '%s' "$cmd" | base64 2>/dev/null | tr -d '\n')
        if [[ -n "$b64" ]]; then
            printf '\033]133;C;cl=%s\007' "$b64"
            return
        fi
    fi
    printf '\033]133;C\007'
}

# Order matters: emit OSC 7 (cwd) BEFORE the D marker so the parser
# associates the *post*-command cwd with the D marker. If D fires
# first, it gets stamped with the cwd as it was when the previous
# command finished — i.e. the user sees `cd foo` paired with the
# pre-cd directory.
__hsp_precmd() {
    __hsp_last_status=$?
    # Disarm for the duration of PROMPT_COMMAND: we run first, so every other
    # precmd hook after us runs with the gate closed and can't trip the DEBUG
    # trap into emitting a stray C. __hsp_arm (last entry) re-arms at the end.
    __hsp_at_prompt=""
    __hsp_emit_cwd
    if [[ -n "$__hsp_in_command" ]]; then
        __hsp_command_done
        __hsp_in_command=""
    fi
}

# Re-arm the gate. Installed as the final PROMPT_COMMAND entry so it runs after
# all other precmd hooks; the next DEBUG firing is then the user's real command.
__hsp_arm() { __hsp_at_prompt=1; }

__hsp_preexec() {
    # DEBUG fires before every simple command — including the precmd hooks bash
    # runs from PROMPT_COMMAND (ours, plus other integrations'). Only the first
    # DEBUG after the prompt has redrawn and re-armed the gate is a real user
    # command; ignore everything else, otherwise a stray C marker lands and the
    # host pairs the wrong C with the next D (or sees a phantom running command).
    [[ -n "$__hsp_at_prompt" ]] || return
    # Snapshot BASH_COMMAND at the very top — any later expansion or
    # subshell could change it. This is the literal text of the
    # command bash is about to run.
    local cmd=${BASH_COMMAND:-}
    # Belt-and-suspenders: never treat one of our own hook functions (or its
    # internal commands) as the user's command. This also covers the brief
    # window inside our own precmd before it disarms the gate.
    case "$cmd" in
        __hsp_*) return ;;
    esac
    # Disarm before emitting so the simple commands inside __hsp_output_start
    # don't re-enter, and so a multi-statement line (`cmd1; cmd2`) is captured
    # as a single B → C → D cycle rather than one stray C per statement.
    __hsp_at_prompt=""
    __hsp_in_command=1
    __hsp_output_start "$cmd"
}

# Wrap PS1 so the visible prompt is bracketed by A (start) and B (end).
# \[ ... \] tells bash these bytes are non-printing so prompt-width math
# stays correct.
if [[ -z "${__HSP_PS1_WRAPPED:-}" ]]; then
    PS1='\[\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'
    __HSP_PS1_WRAPPED=1
fi

# Hook into PROMPT_COMMAND. __hsp_precmd runs FIRST so $? is the user's command
# exit (not whatever a later hook returns) and so it disarms the gate before
# other hooks run; __hsp_arm runs LAST so the gate is re-armed only after every
# other precmd hook has executed. Handle both forms of PROMPT_COMMAND: a plain
# string, and the array bash 5.1+ uses (systemd's osc-context does
# `PROMPT_COMMAND+=(__systemd_osc_context_precmdline)`, which makes it an
# array — a naive scalar concat would drop or reorder those entries).
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == 'declare -a'* ]]; then
    PROMPT_COMMAND=(__hsp_precmd "${PROMPT_COMMAND[@]}" __hsp_arm)
else
    PROMPT_COMMAND="__hsp_precmd;${PROMPT_COMMAND:+$PROMPT_COMMAND;}__hsp_arm"
fi

trap '__hsp_preexec' DEBUG
