/**
 * Saved prompt catalog store. Wraps the `db_*_prompt` IPC commands and keeps a
 * reactive list of the user's saved prompts. Built-in starter prompts live in
 * `$lib/agent/jobs/promptCatalog` and are merged in at the UI layer.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PromptScope } from '$lib/agent/jobs/promptCatalog';
import { logDebug } from '$lib/debug-log';

export interface SavedPrompt {
	id: number;
	name: string;
	scope: PromptScope;
	prompt: string;
	created_at: number;
}

export interface SavedPromptInput {
	name: string;
	scope: PromptScope;
	prompt: string;
}

let saved = $state<SavedPrompt[]>([]);
let loaded = $state(false);

export function getSavedPrompts(): SavedPrompt[] {
	return saved;
}

/** Load saved prompts once (idempotent). Call before showing a catalog picker. */
export async function ensureSavedPromptsLoaded(): Promise<void> {
	if (loaded) return;
	await reloadSavedPrompts();
}

export async function reloadSavedPrompts(): Promise<void> {
	try {
		saved = await invoke<SavedPrompt[]>('db_list_prompts');
		loaded = true;
	} catch (e) {
		logDebug('jobs', 'failed to load saved prompts', { error: String(e) });
		saved = [];
	}
}

/** Save a new prompt; returns its id (or null on failure). Refreshes the list. */
export async function createSavedPrompt(input: SavedPromptInput): Promise<number | null> {
	try {
		const id = await invoke<number>('db_create_prompt', { input });
		await reloadSavedPrompts();
		return id;
	} catch (e) {
		logDebug('jobs', 'failed to save prompt', { error: String(e) });
		return null;
	}
}

export async function deleteSavedPrompt(id: number): Promise<boolean> {
	try {
		await invoke('db_delete_prompt', { id });
		await reloadSavedPrompts();
		return true;
	} catch (e) {
		logDebug('jobs', 'failed to delete prompt', { error: String(e) });
		return false;
	}
}
