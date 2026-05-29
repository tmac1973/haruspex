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
    __hsp_emit_cwd
    if [[ -n "$__hsp_in_command" ]]; then
        __hsp_command_done
        __hsp_in_command=""
    fi
}

__hsp_preexec() {
    # Snapshot BASH_COMMAND at the very top — any later expansion or
    # subshell could change it. This is the literal text of the
    # command bash is about to run.
    local cmd=${BASH_COMMAND:-}
    # DEBUG fires before every simple command, including those inside
    # PROMPT_COMMAND itself. Suppress those by checking the FUNCNAME
    # stack — if any of our own functions is on the call chain, we're
    # being invoked from inside precmd and should NOT emit a C marker.
    #
    # FUNCNAME[0] is "__hsp_preexec" itself (skip), so we check [1+].
    # This is more robust than a manual flag because a bash error
    # inside precmd that bypasses the flag-clear can't strand us.
    local f
    for f in "${FUNCNAME[@]:1}"; do
        case "$f" in
            __hsp_precmd|__hsp_command_done|__hsp_emit_cwd|__hsp_prompt_start|__hsp_prompt_end|__hsp_output_start)
                return
                ;;
        esac
    done
    # Multi-statement input on a single Enter (`cmd1; cmd2` or a
    # multi-line paste) fires DEBUG for each statement. We want a C
    # marker for each so the host can capture them as separate
    # B → C → D cycles for as long as PROMPT_COMMAND fires between
    # them. (For a single multi-statement input, PROMPT_COMMAND only
    # fires once at the very end — that case is inherently captured
    # as one cycle with the first statement's text as the "command".)
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

# Hook precmd into PROMPT_COMMAND. Run ours first so $? is the user's
# command exit, not whatever later PROMPT_COMMAND entries return.
if [[ -z "${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND='__hsp_precmd'
else
    PROMPT_COMMAND='__hsp_precmd;'"$PROMPT_COMMAND"
fi

trap '__hsp_preexec' DEBUG
