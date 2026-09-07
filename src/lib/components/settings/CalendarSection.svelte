<script lang="ts">
	/**
	 * CalDAV accounts. One card per account, like the MCP servers.
	 *
	 * "Check" runs discovery from the form, so a wrong password is caught while
	 * the user is still looking at the field holding it — rather than the first
	 * time the model is asked about their week and answers that they have
	 * nothing on.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { IPC } from '$lib/ipc/commands';
	import { getSettings, setDavAccounts } from '$lib/stores/settings';
	import type { DavAccount } from '$lib/ipc/gen/DavAccount';
	import type { DiscoveredCalendar } from '$lib/ipc/gen/DiscoveredCalendar';

	let accounts = $state<DavAccount[]>(structuredClone(getSettings().integrations.dav.accounts));
	let checking = $state<string | null>(null);
	let found = $state<Record<string, DiscoveredCalendar[]>>({});
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
				contactsUrl: null
			}
		]);
	}

	async function check(account: DavAccount): Promise<void> {
		checking = account.id;
		errors = { ...errors, [account.id]: '' };
		try {
			const calendars = await invoke<DiscoveredCalendar[]>(IPC.dav_discover_calendars, {
				account,
				proxy: getSettings().proxy
			});
			found = { ...found, [account.id]: calendars };
			// A check that worked is the signal the account is ready; turning it
			// on by hand afterwards is a step with no decision in it.
			if (!account.enabled) update(account.id, { enabled: true });
		} catch (e) {
			errors = { ...errors, [account.id]: String(e) };
			found = { ...found, [account.id]: [] };
		} finally {
			checking = null;
		}
	}
</script>

<section class="settings-section">
	<h2>Calendar</h2>
	<p class="section-help">
		Read your calendar from a CalDAV server. Works with Nextcloud, Fastmail, iCloud, Radicale,
		Baikal and Synology.
	</p>
	<p class="section-help" title="Its CalDAV endpoint requires OAuth, which this does not do.">
		For Google Calendar, add it under MCP integrations instead.
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

		{#if errors[account.id]}
			<p class="error">{errors[account.id]}</p>
		{/if}
		{#if found[account.id]?.length}
			<p class="found">
				Found {found[account.id].length} calendar{found[account.id].length === 1 ? '' : 's'}:
				{found[account.id].map((c) => c.name).join(', ')}
			</p>
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
