/**
 * Contact tools, over CardDAV.
 *
 * Two tools, split the way the questions are. "What's Sarah's number" wants one
 * card in full; "who do I know at Example Ltd" wants a list of names. Serving
 * both from one tool means either flooding the context with full cards or
 * never being able to read one.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { Contact } from '$lib/ipc/gen/Contact';
import type { ContactQueryResult } from '$lib/ipc/gen/ContactQueryResult';
import { getSettings } from '$lib/stores/settings';
import { resolveDavAccounts } from './calendar';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

/** `home: +44 …`, or just the value when the card said nothing about kind. */
function typed(values: { kind: string | null; value: string }[]): string[] {
	return values.map((v) => (v.kind ? `${v.kind}: ${v.value}` : v.value));
}

/**
 * One line per contact: enough to pick the right one out of a list, and not so
 * much that twenty of them crowd out the conversation.
 */
export function formatBrief(contact: Contact): string {
	const parts = [contact.fullName || '(no name)'];
	if (contact.organization) parts.push(contact.organization);
	if (contact.emails.length) parts.push(contact.emails[0].value);
	if (contact.phones.length) parts.push(contact.phones[0].value);
	return parts.join(' — ');
}

/** Everything on the card, for when the question was about one person. */
export function formatFull(contact: Contact): string {
	const lines = [contact.fullName || '(no name)'];
	const add = (label: string, value: string | null | undefined) => {
		if (value) lines.push(`${label}: ${value}`);
	};
	add('Organization', contact.organization);
	add('Title', contact.title);
	for (const email of typed(contact.emails)) lines.push(`Email — ${email}`);
	for (const phone of typed(contact.phones)) lines.push(`Phone — ${phone}`);
	for (const address of typed(contact.addresses)) lines.push(`Address — ${address}`);
	add('Birthday', contact.birthday);
	add('Note', contact.note);
	lines.push(`[${contact.accountLabel} / ${contact.addressBook}] id: ${contact.uid}`);
	// Said rather than shown: the bytes are deliberately left on the server,
	// and a model that knows a photo exists can say so if asked.
	if (contact.hasPhoto) lines.push('(has a photo, not loaded)');
	return lines.join('\n');
}

/**
 * Render a result, keeping failures next to whatever did come back.
 *
 * An unreachable address book and an empty one are different answers, and
 * collapsing them lets the model tell someone they know nobody at a company
 * where the server simply did not respond.
 */
export function formatResult(
	result: ContactQueryResult,
	emptyMessage: string,
	render: (c: Contact) => string
): string {
	const lines: string[] = [];
	if (result.contacts.length === 0) {
		lines.push(emptyMessage);
	} else {
		lines.push(...result.contacts.map(render));
		if (result.totalMatched > result.contacts.length) {
			lines.push(
				`…and ${result.totalMatched - result.contacts.length} more. Narrow the search to see them.`
			);
		}
	}
	if (result.problems.length > 0) {
		lines.push('', 'Some address books could not be read:');
		lines.push(...result.problems.map((p) => `- ${p}`));
	}
	return lines.join('\n');
}

const ACCOUNT_ARG = {
	type: 'string',
	description: 'Which account to look in, by name or id. Omit to search every connected account.'
} as const;

registerTool({
	category: 'contacts',
	schema: {
		type: 'function',
		function: {
			name: 'contacts_search',
			description:
				"Search the user's address book. Matches name, email, phone, organization, title, address and notes. Returns a short line per match — use contacts_get for one person's full details.",
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'Text to look for: a name, part of an email address, a company, or a phone number.'
					},
					account: ACCOUNT_ARG
				},
				required: ['query']
			}
		}
	},
	displayLabel: (args) => `Contacts: ${String(args.query ?? '')}`,
	execute: async (args) => {
		const query = String(args.query ?? '').trim();
		if (!query) {
			return toolResult(toolError('contacts_search needs something to search for.'));
		}
		const accounts = resolveDavAccounts(args.account as string | undefined);
		if (accounts.length === 0) {
			return toolResult(
				toolError('No contacts account matched. The user can add one in Settings → Integrations.')
			);
		}
		try {
			const result = await invoke<ContactQueryResult>(IPC.dav_search_contacts, {
				accounts,
				query,
				proxy: getSettings().proxy
			});
			return toolResult(
				formatResult(result, `Nobody matching "${query}" in the address book.`, formatBrief)
			);
		} catch (e) {
			return toolResult(toolError(`Could not search contacts: ${String(e)}`));
		}
	}
});

registerTool({
	category: 'contacts',
	schema: {
		type: 'function',
		function: {
			name: 'contacts_get',
			description:
				"Get one contact's full details — every email, phone, address, birthday and note on the card.",
			parameters: {
				type: 'object',
				properties: {
					identifier: {
						type: 'string',
						description:
							"The person's name, one of their email addresses, or the id from a contacts_search result."
					},
					account: ACCOUNT_ARG
				},
				required: ['identifier']
			}
		}
	},
	displayLabel: (args) => `Contact: ${String(args.identifier ?? '')}`,
	execute: async (args) => {
		const identifier = String(args.identifier ?? '').trim();
		if (!identifier) {
			return toolResult(toolError('contacts_get needs a name, email address or id.'));
		}
		const accounts = resolveDavAccounts(args.account as string | undefined);
		if (accounts.length === 0) {
			return toolResult(
				toolError('No contacts account matched. The user can add one in Settings → Integrations.')
			);
		}
		try {
			const result = await invoke<ContactQueryResult>(IPC.dav_get_contact, {
				accounts,
				identifier,
				proxy: getSettings().proxy
			});
			return toolResult(
				formatResult(
					result,
					`No contact called "${identifier}". Try contacts_search to find how they are listed.`,
					formatFull
				)
			);
		} catch (e) {
			return toolResult(toolError(`Could not read the contact: ${String(e)}`));
		}
	}
});
