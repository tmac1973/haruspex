# Haruspex shell integration for bash.
# Sourced after the user's normal startup files. Emits OSC 133 prompt
# markers (A=prompt start, B=prompt end, C=command output start,
# D=command end + exit code) and OSC 7 cwd updates so the host app can
# locate the last command and its output in the byte stream.

if [[ -n "${__HSP_INTEGRATION_LOADED:-}" ]]; then
    return 0
fi
__HSP_INTEGRATION_LOADED=1

# Flag: set while we're between preexec and precmd (i.e. user's command
# is running). Used to suppress DEBUG-trap output marker emission during
# PROMPT_COMMAND's own simple commands.
__hsp_in_command=""
__hsp_last_status=0

__hsp_prompt_start()  { printf '\033]133;A\007'; }
__hsp_prompt_end()    { printf '\033]133;B\007'; }
__hsp_output_start()  { printf '\033]133;C\007'; }
__hsp_command_done()  { printf '\033]133;D;%s\007' "$__hsp_last_status"; }
__hsp_emit_cwd()      { printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }

__hsp_precmd() {
    __hsp_last_status=$?
    # If we just finished running a user command, emit D.
    if [[ -n "$__hsp_in_command" ]]; then
        __hsp_command_done
    fi
    __hsp_emit_cwd
    # IMPORTANT: clear the flag LAST, after emit_cwd. The DEBUG trap
    # fires before every simple command — including the ones inside
    # this function. If we clear the flag before emit_cwd, the trap
    # sees in_command="" and emits a spurious C marker, then sets the
    # flag back to "1". That spurious flag-set then suppresses the C
    # for the user's next command, breaking the B → C → D cycle. The
    # fix is to keep in_command set through the entire precmd body so
    # every DEBUG firing inside it is correctly suppressed.
    __hsp_in_command=""
}

__hsp_preexec() {
    # DEBUG fires before every simple command. We only care about the
    # first one that runs after a prompt is displayed (the user's
    # command). Subsequent firings during PROMPT_COMMAND are gated by
    # the __hsp_in_command flag.
    if [[ -n "$__hsp_in_command" ]]; then
        return
    fi
    __hsp_in_command=1
    __hsp_output_start
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
