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
	 *
	 * A calendar link is the second kind: one read-only calendar from its iCal
	 * address. The link is the credential, so it is kept where a password is.
	 *
	 * A Google account is the third: "Sign in with Google" runs the consent in
	 * the browser, and Rust keeps the refresh token in the secret store — only
	 * its key comes back here. Offered only by builds that carry Haruspex's
	 * OAuth client.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { IPC } from '#lib/ipc/commands.ts';
	import { getSettings, setDavAccounts, snapshot } from '#lib/stores/settings.ts';
	import type { DavAccount } from '#lib/ipc/gen/DavAccount.ts';
	import type { DavKind } from '#lib/ipc/gen/DavKind.ts';
	import type { GoogleSignIn } from '#lib/ipc/gen/GoogleSignIn.ts';
	import type { DavCollections } from '#lib/ipc/gen/DavCollections.ts';
	import { forgetDavPassword, withStoredDavPassword } from '#lib/stores/davSecrets.ts';
	import {
		savedSecretPlaceholder,
		secretStoreKind,
		type SecretStoreKind
	} from '#lib/stores/secrets.ts';

	let accounts = $state<DavAccount[]>(snapshot(getSettings().integrations.dav.accounts));
	let checking = $state<string | null>(null);
	let found = $state<Record<string, DavCollections>>({});
	let errors = $state<Record<string, string>>({});
	/** A password being typed, per account. Kept here, not in the settings,
	 *  until the field loses focus and it goes to the secret store. */
	let drafts = $state<Record<string, string>>({});
	let storeKind = $state<SecretStoreKind>('keychain');
	void secretStoreKind().then((k) => (storeKind = k));
	let googleAvailable = $state(false);
	/** The account a Google sign-in is running for, while the browser is open. */
	let signingIn = $state<string | null>(null);
	/** A sign-in that failed before its account existed. */
	let googleError = $state('');

	onMount(() => {
		invoke<boolean>(IPC.google_sign_in_available)
			.then((ok) => (googleAvailable = ok))
			.catch(() => (googleAvailable = false));
	});

	function newId(): string {
		return typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `dav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/** Sign in to Google, for a new account or again for an existing one. */
	async function signInWithGoogle(existing?: DavAccount): Promise<void> {
		const id = existing?.id ?? newId();
		signingIn = id;
		googleError = '';
		errors = { ...errors, [id]: '' };
		try {
			const result = await invoke<GoogleSignIn>(IPC.google_sign_in, {
				accountId: id,
				proxy: getSettings().proxy
			});
			const account: DavAccount = {
				id,
				kind: 'google',
				label: existing?.label || 'Google',
				enabled: true,
				address: result.email,
				username: result.email,
				password: result.password,
				passwordRef: result.passwordRef ?? undefined,
				calendarUrl: null,
				contactsUrl: null,
				hasCalendars: result.hasCalendars,
				hasContacts: result.hasContacts
			};
			persist(existing ? accounts.map((a) => (a.id === id ? account : a)) : [...accounts, account]);
			await check(account);
		} catch (e) {
			if (existing) errors = { ...errors, [id]: String(e) };
			else googleError = String(e);
		} finally {
			signingIn = null;
		}
	}

	async function savePassword(id: string): Promise<void> {
		const draft = drafts[id];
		const account = accounts.find((a) => a.id === id);
		if (!draft || !account) return;
		try {
			const stored = await withStoredDavPassword(account, draft);
			update(id, { password: stored.password, passwordRef: stored.passwordRef });
			drafts = { ...drafts, [id]: '' };
		} catch (e) {
			const what = account.kind === 'ics' ? 'link' : 'password';
			errors = { ...errors, [id]: `Could not save the ${what}: ${String(e)}` };
		}
	}

	async function remove(account: DavAccount): Promise<void> {
		persist(accounts.filter((a) => a.id !== account.id));
		// Tell Google first, while the token can still be read.
		if (account.kind === 'google') {
			await invoke(IPC.google_sign_out, { account, proxy: getSettings().proxy }).catch(() => {});
		}
		void forgetDavPassword(account);
	}

	function persist(next: DavAccount[]): void {
		accounts = next;
		setDavAccounts(next);
	}

	function update(id: string, patch: Partial<DavAccount>): void {
		persist(accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)));
	}

	function add(kind: DavKind): void {
		const id = newId();
		persist([
			...accounts,
			{
				id,
				kind,
				label: 'Calendar',
				enabled: false,
				address: '',
				username: '',
				password: '',
				calendarUrl: null,
				contactsUrl: null,
				hasCalendars: null,
				// A link is one calendar and never an address book.
				hasContacts: kind === 'ics' ? false : null
			}
		]);
	}

	async function check(account: DavAccount): Promise<void> {
		checking = account.id;
		if (account.kind !== 'google') await savePassword(account.id);
		account = accounts.find((a) => a.id === account.id) ?? account;
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
	<p
		class="section-help"
		title="A server account works with Nextcloud, Fastmail, iCloud, Radicale, Baikal and Synology, and reads contacts too. A calendar link is read-only and works with Google, Outlook, iCloud and anything that publishes an iCal feed."
	>
		Read your calendars from a CalDAV/CardDAV server account or a calendar link.
	</p>
	<p
		class="section-help"
		title="In Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. Google's CalDAV needs OAuth, so a server account cannot reach it."
	>
		{googleAvailable
			? 'For Google, sign in with Google or add a calendar link.'
			: 'For Google Calendar, add a calendar link.'}
	</p>
	{#if accounts.length === 0}
		<p class="section-help">No accounts yet.</p>
	{/if}
	<div class="actions">
		{#if googleAvailable}
			<button
				type="button"
				disabled={signingIn !== null}
				onclick={() => signInWithGoogle()}
				title="Opens Google in your browser. Haruspex asks to read your calendars and contacts, never to change them."
			>
				{signingIn && !accounts.some((a) => a.id === signingIn)
					? 'Waiting for Google…'
					: 'Sign in with Google'}
			</button>
		{/if}
		<button type="button" onclick={() => add('ics')}>Add a calendar link</button>
		<button type="button" onclick={() => add('dav')}>Add a server account</button>
	</div>
	{#if googleError}
		<p class="error">{googleError}</p>
	{/if}
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
		{#if account.kind === 'google'}
			<p class="section-help">Signed in as {account.address}.</p>
		{:else if account.kind === 'ics'}
			<div class="field">
				<label
					for="dav-link-{account.id}"
					title="Read-only. Anyone with this link can read the calendar, so Haruspex keeps it like a password."
				>
					Calendar link
				</label>
				<input
					id="dav-link-{account.id}"
					type="password"
					autocomplete="off"
					value={drafts[account.id] ?? ''}
					oninput={(e) => (drafts = { ...drafts, [account.id]: e.currentTarget.value })}
					onblur={() => savePassword(account.id)}
					placeholder={account.passwordRef || account.password
						? savedSecretPlaceholder(storeKind)
						: 'https://… or webcal://…'}
				/>
			</div>
		{:else}
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
					value={drafts[account.id] ?? ''}
					oninput={(e) => (drafts = { ...drafts, [account.id]: e.currentTarget.value })}
					onblur={() => savePassword(account.id)}
					placeholder={account.passwordRef || account.password
						? savedSecretPlaceholder(storeKind)
						: ''}
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
		{/if}

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
			{#if account.kind === 'google' && googleAvailable}
				<button
					type="button"
					disabled={signingIn !== null}
					onclick={() => signInWithGoogle(account)}
				>
					{signingIn === account.id ? 'Waiting for Google…' : 'Sign in again'}
				</button>
			{/if}
			<button type="button" class="danger" onclick={() => remove(account)}> Remove </button>
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
