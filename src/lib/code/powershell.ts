import { invoke } from '@tauri-apps/api/core';
import type { AgentPowershell } from '#lib/ipc/gen/AgentPowershell.ts';

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
