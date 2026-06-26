/**
 * Saved prompt catalog store. Wraps the `db_*_prompt` IPC commands and keeps a
 * reactive list of the user's saved prompts. Built-in starter prompts live in
 * `$lib/agent/jobs/promptCatalog` and are merged in at the UI layer.
 */

import type { PromptScope } from '$lib/agent/jobs/promptCatalog';
import { dbMutate, dbQuery } from './dbCall';

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
	// `loaded` flips only on success, so a failed load is retried next time
	// ensureSavedPromptsLoaded() runs.
	saved = await dbQuery<SavedPrompt[]>({
		cmd: 'db_list_prompts',
		fallback: [],
		onError: 'failed to load saved prompts',
		onSuccess: () => {
			loaded = true;
		}
	});
}

/** Save a new prompt; returns its id (or null on failure). Refreshes the list. */
export function createSavedPrompt(input: SavedPromptInput): Promise<number | null> {
	return dbQuery<number | null>({
		cmd: 'db_create_prompt',
		args: { input },
		fallback: null,
		onError: 'failed to save prompt',
		onSuccess: reloadSavedPrompts
	});
}

export function deleteSavedPrompt(id: number): Promise<boolean> {
	return dbMutate({
		cmd: 'db_delete_prompt',
		args: { id },
		onError: 'failed to delete prompt',
		onSuccess: reloadSavedPrompts
	});
}
