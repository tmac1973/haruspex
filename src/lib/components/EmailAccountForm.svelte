<script lang="ts">
	/**
	 * Editable form for a single email account. Used by the
	 * Integrations section of the Settings page. The parent owns the
	 * account list and passes one account at a time plus callbacks for
	 * change and delete.
	 *
	 * On provider change we auto-fill the IMAP/SMTP host + port fields
	 * from the matching preset. The user can override any field after
	 * that by typing in it. Picking "Custom" blanks the presets and
	 * lets the user type whatever they want.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import type { EmailAccount, EmailProviderId, EmailTlsMode } from '$lib/stores/settings';

	interface ProviderPreset {
		id: string;
		label: string;
		imap_host: string;
		imap_port: number;
		imap_tls: EmailTlsMode;
		smtp_host: string;
		smtp_port: number;
		smtp_tls: EmailTlsMode;
		app_password_url: string;
		requires_2fa: boolean;
	}

	interface Props {
		account: EmailAccount;
		presets: ProviderPreset[];
		onChange: (next: EmailAccount) => void;
		onDelete: () => void;
	}

	let { account, presets, onChange, onDelete }: Props = $props();

	// Local editable state — committed back via onChange on every
	// meaningful edit so the parent's working list stays authoritative.
	let label = $state(untrack(() => account.label));
	let emailAddress = $state(untrack(() => account.emailAddress));
	let password = $state(untrack(() => account.password));
	let provider = $state<EmailProviderId>(untrack(() => account.provider));
	let imapHost = $state(untrack(() => account.imapHost));
	let imapPort = $state<number | ''>(untrack(() => account.imapPort));
	let imapTls = $state<EmailTlsMode>(untrack(() => account.imapTls));
	let smtpHost = $state(untrack(() => account.smtpHost));
	let smtpPort = $state<number | ''>(untrack(() => account.smtpPort || ''));
	let smtpTls = $state<EmailTlsMode>(untrack(() => account.smtpTls));
	let enabled = $state(untrack(() => account.enabled));

	let testing = $state(false);
	let testError = $state<string | null>(null);
	let testOk = $state(false);

	function currentPreset(): ProviderPreset | undefined {
		return presets.find((p) => p.id === provider);
	}

	function commit() {
		onChange({
			...account,
			label,
			emailAddress,
			password,
			provider,
			enabled,
			// sendEnabled stays false in 10.1 — see README and plan doc.
			sendEnabled: false,
			imapHost,
			imapPort: typeof imapPort === 'number' ? imapPort : 0,
			imapTls,
			smtpHost,
			smtpPort: typeof smtpPort === 'number' ? smtpPort : 0,
			smtpTls
		});
	}

	function onProviderChange(next: EmailProviderId) {
		provider = next;
		const preset = currentPreset();
		if (preset) {
			imapHost = preset.imap_host;
			imapPort = preset.imap_port;
			imapTls = preset.imap_tls;
			smtpHost = preset.smtp_host;
			smtpPort = preset.smtp_port;
			smtpTls = preset.smtp_tls;
		}
		commit();
	}

	async function testConnection() {
		testing = true;
		testError = null;
		testOk = false;
		commit();
		try {
			await invoke('email_test_connection', {
				account: {
					id: account.id,
					label,
					enabled: true,
					sendEnabled: false,
					provider,
					emailAddress,
					password,
					imapHost,
					imapPort: typeof imapPort === 'number' ? imapPort : 0,
					imapTls,
					smtpHost,
					smtpPort: typeof smtpPort === 'number' ? smtpPort : 0,
					smtpTls
				}
			});
			testOk = true;
		} catch (e) {
			testError = String(e);
		} finally {
			testing = false;
		}
	}

	const preset = $derived(currentPreset());
</script>

<div class="email-account">
	<div class="row top">
		<label class="toggle">
			<input type="checkbox" bind:checked={enabled} onchange={commit} />
			<span>Enabled</span>
		</label>
		<button type="button" class="delete" onclick={onDelete}>Delete account</button>
	</div>

	<div class="field">
		<label for="email-label-{account.id}">Label</label>
		<input
			id="email-label-{account.id}"
			type="text"
			bind:value={label}
			placeholder="Work Gmail"
			onblur={commit}
		/>
	</div>

	<div class="field">
		<label for="email-provider-{account.id}">Provider</label>
		<select
			id="email-provider-{account.id}"
			value={provider}
			onchange={(e) =>
				onProviderChange((e.currentTarget as HTMLSelectElement).value as EmailProviderId)}
		>
			{#each presets as p (p.id)}
				<option value={p.id}>{p.label}</option>
			{/each}
			<option value="custom">Custom (enter hosts manually)</option>
		</select>
		{#if preset}
			<p class="hint">
				{#if preset.requires_2fa}
					Requires 2FA on your account.
				{/if}
				Generate an app password at
				<a href={preset.app_password_url} target="_blank" rel="noopener">
					{preset.app_password_url}
				</a>
				and paste it below.
			</p>
		{/if}
	</div>

	<div class="field">
		<label for="email-address-{account.id}">Email address</label>
		<input
			id="email-address-{account.id}"
			type="email"
			bind:value={emailAddress}
			placeholder="you@example.com"
			onblur={commit}
		/>
	</div>

	<div class="field">
		<label for="email-password-{account.id}">App password</label>
		<input
			id="email-password-{account.id}"
			type="password"
			bind:value={password}
			placeholder="16-character app password"
			autocomplete="off"
			onblur={commit}
		/>
	</div>

	<details class="advanced">
		<summary>Advanced — IMAP / SMTP endpoints</summary>

		<div class="field-row">
			<div class="field">
				<label for="imap-host-{account.id}">IMAP host</label>
				<input id="imap-host-{account.id}" type="text" bind:value={imapHost} onblur={commit} />
			</div>
			<div class="field narrow">
				<label for="imap-port-{account.id}">Port</label>
				<input id="imap-port-{account.id}" type="number" bind:value={imapPort} onblur={commit} />
			</div>
			<div class="field narrow">
				<label for="imap-tls-{account.id}">TLS</label>
				<select id="imap-tls-{account.id}" bind:value={imapTls} onchange={commit}>
					<option value="implicit">Implicit</option>
					<option value="starttls">STARTTLS</option>
				</select>
			</div>
		</div>

		<div class="field-row">
			<div class="field">
				<label for="smtp-host-{account.id}">SMTP host</label>
				<input id="smtp-host-{account.id}" type="text" bind:value={smtpHost} onblur={commit} />
			</div>
			<div class="field narrow">
				<label for="smtp-port-{account.id}">Port</label>
				<input id="smtp-port-{account.id}" type="number" bind:value={smtpPort} onblur={commit} />
			</div>
			<div class="field narrow">
				<label for="smtp-tls-{account.id}">TLS</label>
				<select id="smtp-tls-{account.id}" bind:value={smtpTls} onchange={commit}>
					<option value="implicit">Implicit</option>
					<option value="starttls">STARTTLS</option>
				</select>
			</div>
		</div>

		<p class="hint">
			SMTP credentials are stored now but unused until Phase 10.2 adds email sending. Read-only in
			this build.
		</p>
	</details>

	<div class="test-row">
		<button type="button" onclick={testConnection} disabled={testing}>
			{testing ? 'Testing…' : 'Test connection'}
		</button>
		{#if testOk}
			<span class="ok">Connected successfully.</span>
		{/if}
		{#if testError}
			<span class="err">Failed: {testError}</span>
		{/if}
	</div>
</div>

<style>
	.email-account {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1rem;
		background: var(--surface);
	}

	.row.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 500;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
	}

	.field label {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.field input,
	.field select {
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.field select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.field-row {
		display: flex;
		gap: 0.5rem;
	}

	.field-row .field {
		flex: 1;
	}

	.field-row .field.narrow {
		flex: 0 0 120px;
	}

	.advanced {
		margin: 0.75rem 0;
	}

	.advanced summary {
		cursor: pointer;
		padding: 0.25rem 0;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin: 0.25rem 0 0;
	}

	.hint a {
		color: var(--accent);
	}

	.test-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}

	.test-row button {
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
	}

	.test-row button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.delete {
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.delete:hover {
		color: #c33;
		border-color: #c33;
	}

	.ok {
		color: #2a7;
		font-size: 0.9rem;
	}

	.err {
		color: #c33;
		font-size: 0.9rem;
	}
</style>
