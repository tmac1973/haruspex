/**
 * The Code tab's tool profile: `codeMode` WITHOUT `shellMode`. The same code
 * toolset as Shell Code mode, but with no terminal behind it — commands run
 * one-shot, and long-running ones go to background processes the tab owns.
 *
 * Only constants live here, so the registry can import it without the cycle a
 * tool module would make (tool modules register through the registry).
 */

/**
 * Tools offered only in the Code tab (`codeMode && !shellMode`), never in
 * Shell Code mode, Shell or Chat. Gated by name so the gate holds whatever
 * category the tool registers under, and before the tool exists.
 */
export const CODE_TAB_ONLY: ReadonlySet<string> = new Set([
	'command_output',
	'command_stop',
	'open_in_shell',
	'open_in_editor'
]);

/** Text that replaces a tool's schema wording in the Code tab. */
export interface DescriptionOverride {
	description: string;
	/** Per-parameter descriptions, by parameter name. */
	params?: Record<string, string>;
}

/**
 * `run_command` as the Code tab runs it. Its registered description is the
 * Shell Code mode one (live terminal); this is the one-shot wording, with
 * background processes read and stopped through `command_output` /
 * `command_stop` rather than a terminal.
 */
export const CODE_TAB_DESCRIPTIONS: Readonly<Record<string, DescriptionOverride>> = {
	run_command: {
		description:
			"Run a shell command in the project with bash, one-shot. There is no terminal: cwd/env changes don't persist between calls (chain with && when needed), and stdin is closed, so a command that prompts for input or a password (sudo) fails — tell the user instead of retrying it. Output is truncated past ~16KB; if so, the full output is saved to a file path you can read with fs_read_text. For a server, watcher, or any program that does not exit on its own, set background:true — it returns an id at once; read its output with command_output and stop it with command_stop. Add watch:true to be notified when it finishes. Do NOT run such a program in the foreground; it will just time out.",
		params: {
			background:
				'Run detached and return an id immediately. Use for servers / long-running programs so they do not block you. Read the output with command_output; stop it with command_stop.',
			watch:
				'Like background, but you receive a notification turn when the command finishes (with its exit code + output). Use for a long build/test/job whose result you need but do not want to sit and wait for. Do not poll — continue or wrap up; the notification will come.'
		}
	}
};
