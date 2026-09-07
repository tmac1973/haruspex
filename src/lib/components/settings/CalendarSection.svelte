<script lang="ts">
	/**
	 * CalDAV and CardDAV accounts. One card per account, like the MCP servers.
	 *
	 * "Check" runs discovery from the form, so a wrong password is caught while
	 * the user is still looking at the field holding it — rather than the first
	 * time the model is asked about their week and answers that they have
	 * nothing on.
	 *
	 * One account, both collection types: a Nextcloud or Fastmail login reaches
	 * calendars and contacts alike. Check records which the server actually
	 * offered, so a calendar-only account stops presenting contact tools that
	 * could only fail.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { IPC } from '$lib/ipc/commands';
	import { getSettings, setDavAccounts } from '$lib/stores/settings';
	import type { DavAccount } from '$lib/ipc/gen/DavAccount';
	import type { DavCollections } from '$lib/ipc/gen/DavCollections';

	let accounts = $state<DavAccount[]>(structuredClone(getSettings().integrations.dav.accounts));
	let checking = $state<string | null>(null);
	let found = $state<Record<string, DavCollections>>({});
	let errors = $state<Record<string, string>>({});

	function persist(next: DavAccount[]): void {
		accounts = next;
		setDavAccounts(next);
	}

	function update(id: string, patch: Partial<DavAccount>): void {
		persist(accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)));
	}

	function add(): void {
		const id =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `dav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		persist([
			...accounts,
			{
				id,
				label: 'Calendar',
				enabled: false,
				address: '',
				username: '',
				password: '',
				calendarUrl: null,
				contactsUrl: null,
				hasCalendars: null,
				hasContacts: null
			}
		]);
	}

	async function check(account: DavAccount): Promise<void> {
		checking = account.id;
		errors = { ...errors, [account.id]: '' };
		try {
			const collections = await invoke<DavCollections>(IPC.dav_discover_collections, {
				account,
				proxy: getSettings().proxy
			});
			found = { ...found, [account.id]: collections };
			update(account.id, {
				// What the server was seen to serve. Recorded so a calendar-only
				// account stops offering contact tools, and vice versa.
				hasCalendars: collections.calendars.length > 0,
				hasContacts: collections.addressBooks.length > 0,
				// A check that worked is the signal the account is ready; turning
				// it on by hand afterwards is a step with no decision in it.
				enabled: true
			});
		} catch (e) {
			errors = { ...errors, [account.id]: String(e) };
			found = { ...found, [account.id]: undefined as unknown as DavCollections };
		} finally {
			checking = null;
		}
	}

	function names(items: { name: string }[]): string {
		return items.map((i) => i.name).join(', ');
	}
</script>

<section class="settings-section">
	<h2>Calendar &amp; Contacts</h2>
	<p class="section-help">
		Read your calendar and address book from a CalDAV/CardDAV server. Works with Nextcloud,
		Fastmail, iCloud, Radicale, Baikal and Synology.
	</p>
	<p
		class="section-help"
		title="Their CalDAV and CardDAV endpoints require OAuth, which this does not do."
	>
		For Google Calendar and Google Contacts, add them under MCP integrations instead.
	</p>
	{#if accounts.length === 0}
		<p class="section-help">No accounts yet.</p>
	{/if}
	<button type="button" onclick={add}>Add an account</button>
</section>

{#each accounts as account (account.id)}
	<section class="settings-section">
		<h2>{account.label || 'Calendar'}</h2>
		<label class="toggle-row">
			<input
				type="checkbox"
				checked={account.enabled}
				onchange={() => update(account.id, { enabled: !account.enabled })}
			/>
			<span>Enabled</span>
		</label>

		<div class="field">
			<label for="dav-label-{account.id}">Name</label>
			<input
				id="dav-label-{account.id}"
				value={account.label}
				oninput={(e) => update(account.id, { label: e.currentTarget.value })}
				placeholder="Work"
			/>
		</div>
		<div class="field">
			<label for="dav-address-{account.id}">Address or server URL</label>
			<input
				id="dav-address-{account.id}"
				value={account.address}
				oninput={(e) => update(account.id, { address: e.currentTarget.value })}
				placeholder="me@fastmail.com or https://cloud.example.com"
			/>
		</div>
		<div class="field">
			<label for="dav-user-{account.id}">Username</label>
			<input
				id="dav-user-{account.id}"
				value={account.username}
				oninput={(e) => update(account.id, { username: e.currentTarget.value })}
				placeholder="Often the same as the address"
			/>
		</div>
		<div class="field">
			<label for="dav-pass-{account.id}">App password</label>
			<input
				id="dav-pass-{account.id}"
				type="password"
				value={account.password}
				oninput={(e) => update(account.id, { password: e.currentTarget.value })}
			/>
		</div>
		<div class="field">
			<label for="dav-url-{account.id}">Calendar URL (optional)</label>
			<input
				id="dav-url-{account.id}"
				value={account.calendarUrl ?? ''}
				oninput={(e) => update(account.id, { calendarUrl: e.currentTarget.value || null })}
				placeholder="Only if your server is not found automatically"
			/>
		</div>
		<div class="field">
			<label for="dav-contacts-url-{account.id}">Contacts URL (optional)</label>
			<input
				id="dav-contacts-url-{account.id}"
				value={account.contactsUrl ?? ''}
				oninput={(e) => update(account.id, { contactsUrl: e.currentTarget.value || null })}
				placeholder="Only if your server is not found automatically"
			/>
		</div>

		{#if errors[account.id]}
			<p class="error">{errors[account.id]}</p>
		{/if}
		{#if found[account.id]}
			{@const collections = found[account.id]}
			{#if collections.calendars.length}
				<p class="found">Calendars: {names(collections.calendars)}</p>
			{/if}
			{#if collections.addressBooks.length}
				<p class="found">Address books: {names(collections.addressBooks)}</p>
			{/if}
			<!-- Only ever the half that was missing. A server with calendars and
			     no contacts is an ordinary account, not a broken one, so this
			     says what is unavailable rather than reporting a failure. -->
			{#each collections.problems as problem (problem)}
				<p class="section-help">{problem}</p>
			{/each}
		{/if}

		<div class="actions">
			<button type="button" disabled={checking === account.id} onclick={() => check(account)}>
				{checking === account.id ? 'Checking…' : 'Check'}
			</button>
			<button
				type="button"
				class="danger"
				onclick={() => persist(accounts.filter((a) => a.id !== account.id))}
			>
				Remove
			</button>
		</div>
	</section>
{/each}

<style>
	.section-help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0 0 12px 0;
		line-height: 1.5;
	}

	.field {
		margin-top: 10px;
	}
	.field label {
		display: block;
		margin-bottom: 4px;
		font-size: 0.85em;
	}
	.field input {
		width: 100%;
	}
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.9em;
	}
	.found {
		color: var(--accent, #14b8a6);
		font-size: 0.9em;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}
	.danger {
		color: var(--danger, #ef4444);
	}
</style>
