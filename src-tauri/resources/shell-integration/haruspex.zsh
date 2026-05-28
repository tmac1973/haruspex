# Haruspex shell integration for zsh.
# Sourced after the user's normal startup files. Emits OSC 133 prompt
# markers (A=prompt start, B=prompt end, C=command output start,
# D=command end + exit code) and OSC 7 cwd updates so the host app can
# locate the last command and its output in the byte stream.

if [[ -n "${__HSP_INTEGRATION_LOADED:-}" ]]; then
    return 0
fi
typeset -g __HSP_INTEGRATION_LOADED=1
typeset -g __hsp_last_status=0
typeset -g __hsp_in_command=""

__hsp_emit_cwd() { print -n "\e]7;file://${HOST:-localhost}${PWD}\a" }

__hsp_precmd() {
    __hsp_last_status=$?
    if [[ -n "$__hsp_in_command" ]]; then
        print -n "\e]133;D;${__hsp_last_status}\a"
        __hsp_in_command=""
    fi
    __hsp_emit_cwd
}

__hsp_preexec() {
    __hsp_in_command=1
    print -n '\e]133;C\a'
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __hsp_precmd
add-zsh-hook preexec __hsp_preexec

# Wrap the prompt with A (start) and B (end). %{ ... %} marks bytes as
# zero-width so prompt-width math stays correct.
if [[ -z "${__HSP_PS1_WRAPPED:-}" ]]; then
    PROMPT=$'%{\e]133;A\a%}'"${PROMPT}"$'%{\e]133;B\a%}'
    typeset -g __HSP_PS1_WRAPPED=1
fi
