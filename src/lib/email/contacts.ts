/**
 * Contacts' addresses for addressing mail: the Review email dialog's To and
 * Cc suggestions, and `email_compose` given a name rather than an address.
 * Rust keeps the list a few minutes (`dav/contact_book.rs`), so asking again
 * is cheap.
 */
import { invoke } from '@tauri-apps/api/core';
import type { ContactAddress } from '#lib/ipc/gen/ContactAddress.ts';
import type { ContactAddresses } from '#lib/ipc/gen/ContactAddresses.ts';
import { enabledDavAccounts, getSettings } from '#lib/stores/settings.ts';
import { isAddress, mailbox } from '#lib/stores/emailReview.svelte.ts';

export type { ContactAddress };

/** Every contact's addresses; empty with no contacts account. */
export async function loadContactAddresses(): Promise<ContactAddresses> {
	const accounts = enabledDavAccounts().filter((a) => a.kind !== 'ics');
	if (accounts.length === 0) return { addresses: [], problems: [] };
	return invoke<ContactAddresses>('dav_contact_addresses', {
		accounts,
		proxy: getSettings().proxy
	});
}

const words = (s: string) =>
	s
		.toLowerCase()
		.split(/[\s.@_-]+/)
		.filter(Boolean);

/**
 * The contacts a typed fragment could mean, best first: a name or address
 * that starts with it, then one with a word that does. At most `max`.
 */
export function matchContacts(
	list: readonly ContactAddress[],
	typed: string,
	max = 8
): ContactAddress[] {
	const q = typed.trim().toLowerCase();
	if (!q) return [];
	const starts: ContactAddress[] = [];
	const inside: ContactAddress[] = [];
	for (const c of list) {
		const name = c.name.toLowerCase();
		const email = c.email.toLowerCase();
		if (name.startsWith(q) || email.startsWith(q)) starts.push(c);
		else if ([...words(c.name), ...words(c.email)].some((w) => w.startsWith(q))) inside.push(c);
	}
	return [...starts, ...inside].slice(0, max);
}

/** A field's text with its last (partly typed) entry replaced by `c`, ready for the next. */
export function completeField(text: string, c: ContactAddress): string {
	const cut = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
	const before = cut < 0 ? '' : text.slice(0, cut + 1) + ' ';
	return `${before}${mailbox(c.name, c.email)}, `;
}

/** The entry being typed: what follows the last comma or semicolon. */
export function typedEntry(text: string): string {
	const cut = Math.max(text.lastIndexOf(','), text.lastIndexOf(';'));
	return text.slice(cut + 1).trim();
}

/**
 * A recipient the model named: an address passes as it is; a name becomes
 * that contact's `Name <address>` when exactly one address matches. Throws
 * a sentence naming the matches, or saying there were none.
 */
export function resolveRecipient(entry: string, list: readonly ContactAddress[]): string {
	const want = entry.trim();
	if (isAddress(want)) return want;
	const lower = want.toLowerCase();
	const exact = list.filter((c) => c.name.toLowerCase() === lower);
	// An exact name wins over a partial one: "Sam" is Sam, not also Samantha.
	const found = exact.length ? exact : matchContacts(list, want, 50);
	if (found.length === 1) return mailbox(found[0].name, found[0].email);
	if (found.length === 0) {
		throw new Error(`No contact matches "${want}". Give an email address instead.`);
	}
	const options = found
		.slice(0, 8)
		.map((c) => mailbox(c.name, c.email))
		.join('; ');
	throw new Error(`"${want}" could be several addresses: ${options}. Ask the user which one.`);
}
