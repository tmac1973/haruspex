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
		snapshot,
		type EmailAccount,
		type EmailProviderId
	} from '$lib/stores/settings';
	import type { EmailProviderPreset } from '$lib/ipc/gen/EmailProviderPreset';
	import EmailAccountForm from '$lib/components/EmailAccountForm.svelte';
	import { forgetStoredPassword, keychainAvailable } from '$lib/stores/emailSecrets';

	let emailAccounts = $state<EmailAccount[]>(snapshot(getSettings().integrations.email.accounts));
	let emailPresets = $state<EmailProviderPreset[]>([]);
	// Null until probed, so the notice never flashes on a machine that has one.
	let keychain = $state<boolean | null>(null);

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

	/** The backend keeps a logged-in session per account; an edit must not reuse it. */
	function forgetSession(id: string) {
		invoke('email_forget_session', { accountId: id }).catch(() => {});
	}

	function updateEmailAccount(id: string, next: EmailAccount) {
		emailAccounts = emailAccounts.map((a) => (a.id === id ? next : a));
		setEmailAccounts(emailAccounts);
		forgetSession(id);
	}

	function deleteEmailAccount(id: string) {
		const gone = emailAccounts.find((a) => a.id === id);
		if (gone) void forgetStoredPassword(gone);
		emailAccounts = emailAccounts.filter((a) => a.id !== id);
		setEmailAccounts(emailAccounts);
		forgetSession(id);
	}

	onMount(() => {
		void loadEmailPresets();
		void keychainAvailable().then((ok) => (keychain = ok));
	});
</script>

<section class="settings-section">
	<h2>Email</h2>
	<p
		class="section-help"
		title="Gmail, Fastmail, iCloud, Yahoo or any IMAP host. Each needs an app password, which requires 2FA on the account."
	>
		The assistant reads and summarizes mail, and with Allow sending drafts messages you review
		before they go.
	</p>

	{#if keychain === false}
		<p
			class="section-help small"
			title="On Linux, run a Secret Service such as GNOME Keyring or KWallet and restart Haruspex."
		>
			No system keychain found — passwords are kept in Haruspex's settings.
		</p>
	{/if}

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
