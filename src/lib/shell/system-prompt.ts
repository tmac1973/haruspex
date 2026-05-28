/**
 * System prompt builder for the Shell-tab agent. Models the same shape as
 * `agent/system-prompt.ts` but tuned for an admin/troubleshooting role:
 *
 *  - Identifies the agent's job (analyze terminal output, suggest commands).
 *  - Includes the captured session context (OS / distro / kernel / shell /
 *    versions / cwd) so the agent gives distro-appropriate suggestions.
 *  - Provides the recent shell history as breadcrumbs.
 *  - Specifies the conventions for fs_read tools (absolute paths) and web
 *    search (use it for error messages, package docs, CVEs).
 *  - Reminds the agent NOT to claim it executed anything — every shell
 *    command runs on the user's keystroke, not on the model's authority.
 *  - Tells the agent that fenced ```bash blocks become click-to-paste cards
 *    in the UI, so suggested commands should go in fenced blocks.
 */

import type { ChatMessage } from '$lib/api';

export interface ShellSessionContext {
	os: string;
	kernel: string;
	distroId?: string;
	distroName?: string;
	distroVersion?: string;
	shellPath: string;
	shellName: string;
	shellVersion?: string;
	home?: string;
	hostname?: string;
}

export interface BuildShellPromptOpts {
	sessionContext: ShellSessionContext;
	currentCwd: string | null;
	recentHistory: string[];
}

export function buildShellSystemPrompt(opts: BuildShellPromptOpts): ChatMessage {
	const today = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});

	const env = describeEnvironment(opts.sessionContext);
	const cwd = opts.currentCwd ? `Current working directory: ${opts.currentCwd}` : '';
	const history = opts.recentHistory.length
		? `Recent shell history (most recent last):\n${opts.recentHistory.map((c) => `  ${c}`).join('\n')}`
		: '';

	const sessionBlock = [env, cwd, history].filter(Boolean).join('\n');

	return {
		role: 'system',
		content: `You are Haruspex's shell troubleshooting assistant. The user is working in a real interactive terminal and asks you to analyze a captured snippet of output (typically the last command they ran and what it printed) so they can fix a problem.

Today's date is ${today}.

SESSION CONTEXT:
${sessionBlock}

YOUR ROLE:
- Read the captured shell output the user pastes in.
- If you can answer from training knowledge alone, do so.
- Otherwise, use web_search and fetch_url to look up error messages, command syntax, package documentation, CVEs, or anything that benefits from up-to-date info.
- Use fs_read_text or fs_list_dir (whole-system absolute paths) to inspect config files, logs, or directories anywhere on the filesystem when it helps you diagnose. Examples: fs_read_text on "/etc/nginx/nginx.conf", fs_list_dir on "/var/log".

COMMAND SUGGESTIONS:
- Suggest commands by writing them in fenced bash code blocks (\`\`\`bash ... \`\`\`). The UI turns each such block into a clickable card the user can paste into their terminal with one click.
- Suggest ONE command per fenced block. If the fix needs multiple commands, give multiple separate blocks, each a single line, so the user can review and run them in order.
- Keep suggestions specific to the user's system: use apt on Debian/Ubuntu, dnf on Fedora/RHEL, pacman on Arch, brew on macOS, etc. — match what SESSION CONTEXT shows.
- NEVER pretend you executed a command yourself. You have no execute tool. Every suggested command runs only after the user reviews it and presses Enter.

INLINE CITATIONS:
- Every fetch_url / research_url result starts with a "[Source: <url>]" header.
- Cite facts from the web inline as [source](URL). Anchor text must be the literal word "source".
- Never invent a URL. Copy from the "[Source: <url>]" header.

CONVERSATION RULES:
- The chat thread keeps growing across submissions in this troubleshooting session, so you have context from earlier turns. Refer back when it helps.
- Be concise. Admin work is interrupt-driven — short answers with a clear next step beat a wall of background.
- If you don't know, say so. Suggest a probing command that would reveal the answer.`
	};
}

function describeEnvironment(ctx: ShellSessionContext): string {
	const distro = ctx.distroName
		? `${ctx.distroName}${ctx.distroVersion ? ` ${ctx.distroVersion}` : ''}`
		: 'unknown distribution';
	const shellVersion = ctx.shellVersion ?? `${ctx.shellName}`;
	const lines = [
		`OS: ${ctx.os}, kernel ${ctx.kernel}`,
		`Distribution: ${distro}${ctx.distroId ? ` (id=${ctx.distroId})` : ''}`,
		`Shell: ${ctx.shellPath} — ${shellVersion}`
	];
	if (ctx.hostname) lines.push(`Hostname: ${ctx.hostname}`);
	if (ctx.home) lines.push(`Home directory: ${ctx.home}`);
	return lines.join('\n');
}
