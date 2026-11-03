/**
 * Emails moved to Trash from Home. A card's list is its job's last result,
 * which still names them until the next check, so the cards (and the web
 * client's payload) leave these out. Kept for the app's life: a check after
 * the delete no longer finds them in INBOX anyway.
 */
import { SvelteSet } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core';
import type { EmailAccount } from '#lib/stores/settings.ts';

const trashed = new SvelteSet<string>();

export function isTrashed(itemId: string): boolean {
	return trashed.has(itemId);
}

/** Move the message to the account's Trash; rejects with the server's reason. */
export async function trashEmail(
	account: EmailAccount,
	itemId: string,
	messageId: string
): Promise<void> {
	await invoke('email_trash', { account, messageId });
	trashed.add(itemId);
}

export function _resetForTests(): void {
	trashed.clear();
}
