import { invoke } from '@tauri-apps/api/core';
import type { AgentPowershell } from '#lib/ipc/gen/AgentPowershell.ts';
import { getSettings } from '#lib/stores/settings.ts';

let found: Promise<AgentPowershell | null> | null = null;

/**
 * The PowerShell a Code session in a Windows folder runs its commands in
 * (PowerShell 7, else Windows PowerShell 5.1), for the system prompt to name.
 * Asked of Rust once; null off Windows or when it can't say.
 */
export function agentPowershell(): Promise<AgentPowershell | null> {
	found ??= invoke<AgentPowershell | null>('code_powershell').catch(() => null);
	return found;
}

/**
 * The PowerShell a session in a Windows folder hands a command to with
 * `open_in_shell`: the Shell picker's when it is one (the Store's pwsh is
 * fine for a person), else the agent's. Null off Windows.
 */
export async function handoffPowershell(): Promise<string | null> {
	const sel = getSettings().shellSelection;
	if (sel?.kind === 'powershell') return sel.exe;
	return (await agentPowershell())?.exe ?? null;
}
