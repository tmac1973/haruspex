<script lang="ts">
	/**
	 * Email account configuration card. Loads the IMAP/SMTP provider
	 * presets on mount, mirrors `settings.integrations.email.accounts`
	 * into local state, and persists via `setEmailAccounts` on every
	 * mutation. Each account renders through `EmailAccountForm`; this
	 * component owns the add/update/delete CRUD around that.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import {
		getSettings,
		setEmailAccounts,
		type EmailAccount,
		type EmailProviderId
	} from '$lib/stores/settings';
	import type { EmailProviderPreset } from '$lib/ipc/gen/EmailProviderPreset';
	import EmailAccountForm from '$lib/components/EmailAccountForm.svelte';

	let emailAccounts = $state<EmailAccount[]>(
		structuredClone(getSettings().integrations.email.accounts)
	);
	let emailPresets = $state<EmailProviderPreset[]>([]);

	async function loadEmailPresets() {
		try {
			emailPresets = await invoke<EmailProviderPreset[]>('email_list_providers');
		} catch (e) {
			console.error('email_list_providers failed:', e);
		}
	}

	function newBlankAccount(): EmailAccount {
		// Generate a stable id using the browser's crypto.randomUUID()
		// when available, falling back to a timestamp-plus-random pair
		// for older environments that tauri-webview might present.
		const id =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const preset = emailPresets.find((p) => p.id === 'gmail');
		return {
			id,
			label: 'New account',
			enabled: false,
			sendEnabled: false,
			provider: 'gmail' as EmailProviderId,
			emailAddress: '',
			password: '',
			imapHost: preset?.imap_host ?? 'imap.gmail.com',
			imapPort: preset?.imap_port ?? 993,
			imapTls: preset?.imap_tls ?? 'implicit',
			smtpHost: preset?.smtp_host ?? 'smtp.gmail.com',
			smtpPort: preset?.smtp_port ?? 465,
			smtpTls: preset?.smtp_tls ?? 'implicit'
		};
	}

	function addEmailAccount() {
		emailAccounts = [...emailAccounts, newBlankAccount()];
		setEmailAccounts(emailAccounts);
	}

	function updateEmailAccount(id: string, next: EmailAccount) {
		emailAccounts = emailAccounts.map((a) => (a.id === id ? next : a));
		setEmailAccounts(emailAccounts);
	}

	function deleteEmailAccount(id: string) {
		emailAccounts = emailAccounts.filter((a) => a.id !== id);
		setEmailAccounts(emailAccounts);
	}

	onMount(loadEmailPresets);
</script>

<section>
	<h2>Email (read-only)</h2>
	<p class="section-help">
		Multi-provider IMAP access for reading recent email and summarizing it. Supports Gmail,
		Fastmail, iCloud, Yahoo, and any IMAP host you can reach. Every preset requires 2FA to be
		enabled on the provider and an app password (not your login password). Sending email arrives in
		a later phase.
	</p>

	{#if emailAccounts.length === 0}
		<p class="section-help small">No email accounts configured.</p>
	{/if}

	{#each emailAccounts as account (account.id)}
		<EmailAccountForm
			{account}
			presets={emailPresets}
			onChange={(next) => updateEmailAccount(account.id, next)}
			onDelete={() => deleteEmailAccount(account.id)}
		/>
	{/each}

	<button class="btn" onclick={addEmailAccount}>Add email account</button>
</section>

<style>
	section {
		margin-bottom: 32px;
	}

	h2 {
		font-size: 1rem;
		margin: 0 0 8px 0;
		color: var(--text-primary);
	}

	.section-help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		margin: 0 0 12px 0;
		line-height: 1.5;
	}

	.section-help.small {
		font-size: 0.8rem;
	}
</style>
