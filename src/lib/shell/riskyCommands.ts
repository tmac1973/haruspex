/**
 * Heuristic detector for shell commands that warrant a visible warning.
 * Used by the Shell-tab markdown renderer to badge suggested commands so
 * the user reads before pressing Enter.
 *
 * The list is short on purpose. False negatives are inevitable — the
 * user is still the last line of defense, since nothing executes without
 * a deliberate Enter keystroke. The badges are a heads-up, not a gate.
 */

interface RiskPattern {
	label: string;
	description: string;
	test: (cmd: string) => boolean;
}

const PATTERNS: RiskPattern[] = [
	{
		label: 'sudo',
		description: 'Runs as root',
		test: (cmd) => /(^|[\s|&;`(])sudo\b/.test(cmd)
	},
	{
		label: 'destructive',
		description: 'Recursive force-delete (rm -rf / rm -r)',
		test: (cmd) => /(^|[\s|&;`(])rm\s+(-[a-zA-Z]*[rRfF]|[^|]*\s-[a-zA-Z]*[rRfF])/.test(cmd)
	},
	{
		label: 'overwrites disk',
		description: 'dd writes raw blocks — wrong of= can wipe a disk',
		test: (cmd) => /(^|[\s|&;`(])dd\s+.*\bof=/.test(cmd)
	},
	{
		label: 'reformats disk',
		description: 'mkfs creates a filesystem — destroys existing data on the target',
		test: (cmd) => /(^|[\s|&;`(])mkfs(\.\w+)?\b/.test(cmd)
	},
	{
		label: 'pipes to shell',
		description: 'Executes a remote script — trust the source',
		test: (cmd) => /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/.test(cmd)
	},
	{
		label: 'writes system file',
		description: 'Writes a file under /etc',
		test: (cmd) => />>?\s*\/etc\//.test(cmd)
	},
	{
		label: 'unsafe root override',
		description: '--no-preserve-root removes the safety net protecting /',
		test: (cmd) => /\b--no-preserve-root\b/.test(cmd)
	},
	{
		label: 'system reset',
		description: 'reboot / poweroff / shutdown / halt — disrupts the session',
		test: (cmd) => /(^|[\s|&;`(])(reboot|poweroff|shutdown|halt)\b/.test(cmd)
	},
	{
		label: 'kills processes',
		description: 'pkill / killall / kill -9 can take down running services',
		test: (cmd) =>
			/(^|[\s|&;`(])(pkill|killall)\b/.test(cmd) || /(^|[\s|&;`(])kill\s+-9\b/.test(cmd)
	},
	{
		label: 'erases disk',
		description: 'diskutil eraseDisk / apfs deleteContainer destroys a volume (macOS)',
		test: (cmd) =>
			/(^|[\s|&;`(])diskutil\s+(erase(disk|volume)|apfs\s+(delete|erase)\w*)/i.test(cmd)
	},
	{
		label: 'removes service',
		description: 'launchctl remove/unload can disable a system or login service (macOS)',
		test: (cmd) => /(^|[\s|&;`(])launchctl\s+(remove|unload|bootout)\b/.test(cmd)
	},
	// ---- PowerShell / Windows (case-insensitive; cmdlets are not case-sensitive) ----
	{
		label: 'destructive',
		description: 'Remove-Item -Recurse -Force deletes a whole tree without prompting (PowerShell)',
		test: (cmd) =>
			/(^|[\s|&;`(])(remove-item|rmdir|rd)\b/i.test(cmd) &&
			/\s-r(e(c(u(rse?)?)?)?)?\b/i.test(cmd) &&
			/\s-f(o(rce)?)?\b/i.test(cmd)
	},
	{
		label: 'reformats disk',
		description: 'Format-Volume / Clear-Disk / diskpart destroys data on the target (Windows)',
		test: (cmd) => /(^|[\s|&;`(])(format-volume|clear-disk|diskpart)\b/i.test(cmd)
	},
	{
		label: 'changes security policy',
		description: 'Set-ExecutionPolicy lowers PowerShell script-execution protection',
		test: (cmd) => /(^|[\s|&;`(])set-executionpolicy\b/i.test(cmd)
	},
	{
		label: 'edits registry',
		description: 'reg delete removes registry keys — can break Windows or installed apps',
		test: (cmd) => /(^|[\s|&;`(])reg(\.exe)?\s+delete\b/i.test(cmd)
	},
	{
		label: 'system reset',
		description: 'Stop-Computer / Restart-Computer powers off or reboots the machine (Windows)',
		test: (cmd) => /(^|[\s|&;`(])(stop-computer|restart-computer)\b/i.test(cmd)
	}
];

export interface RiskMatch {
	label: string;
	description: string;
}

export interface RiskResult {
	matched: boolean;
	reasons: RiskMatch[];
}

/**
 * Classify a single-line shell command. For multi-line code blocks the
 * caller should split on newlines and OR the results — but in practice
 * suggested commands are single-line per the system prompt.
 */
export function classifyShellRisk(text: string): RiskResult {
	const reasons: RiskMatch[] = [];
	const trimmed = text.trim();
	for (const p of PATTERNS) {
		if (p.test(trimmed)) {
			reasons.push({ label: p.label, description: p.description });
		}
	}
	return { matched: reasons.length > 0, reasons };
}
