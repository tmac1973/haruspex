<script lang="ts">
	/**
	 * Settings → Cameras → Alerts: whether urgent camera entries are emailed,
	 * from which account and to whom. The addresses typed here are the only
	 * ones alert emails ever go to.
	 */
	import { getCameraAlerts, getSettings, setCameraAlerts } from '#lib/stores/settings.ts';
	import { cleanAlertAddresses, MAX_ALERT_ADDRESSES } from '#lib/camera/alertConfig.ts';
	import { sendAlert } from '#lib/camera/alertDispatch.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const start = getCameraAlerts();
	const accounts = getSettings().integrations.email.accounts.filter(
		(a) => a.enabled && a.sendEnabled
	);
	let enabled = $state(start.enabled);
	let accountId = $state(start.accountId || accounts[0]?.id || '');
	let toText = $state(start.to.join(', '));
	let testing = $state(false);
	let testResult = $state('');
	let testError = $state('');

	const typed = $derived(
		toText
			.split(/[,;\s]+/)
			.map((a) => a.trim())
			.filter(Boolean)
	);
	const cleaned = $derived(cleanAlertAddresses(typed));
	const toError = $derived(
		typed.length > MAX_ALERT_ADDRESSES
			? `At most ${MAX_ALERT_ADDRESSES} addresses.`
			: cleaned.length < typed.length
				? 'One of these is not an email address.'
				: ''
	);

	function save() {
		setCameraAlerts({ enabled, accountId, to: cleaned });
	}

	async function test() {
		save();
		testing = true;
		testResult = '';
		testError = '';
		try {
			await sendAlert({
				kind: 'test',
				lines: ['This is a test of Haruspex camera alerts. Urgent entries will arrive like this.'],
				eventIds: []
			});
			testResult = `Sent to ${cleaned.join(', ')}.`;
		} catch (e) {
			testError = errMessage(e);
		} finally {
			testing = false;
		}
	}
</script>

<section class="settings-section">
	<h2>Alerts</h2>
	<p
		class="help"
		title="An urgent entry is emailed at once with its picture; more within 10 minutes come in one follow-up. Turn on Judge entries for a camera under Edit."
	>
		Email urgent camera entries.
	</p>
	<label class="toggle-row row">
		<input
			type="checkbox"
			bind:checked={enabled}
			onchange={save}
			disabled={accounts.length === 0}
		/>
		<span>Email alerts</span>
	</label>
	{#if accounts.length === 0}
		<p class="help">
			No email account can send. Turn on Allow sending in Settings → Integrations → Email.
		</p>
	{:else}
		<label class="field">
			<span>Send from</span>
			<select bind:value={accountId} onchange={save}>
				{#each accounts as a (a.id)}
					<option value={a.id}>{a.label || a.emailAddress}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span>Send to</span>
			<input
				type="text"
				bind:value={toText}
				onchange={save}
				placeholder="you@example.com"
				title="Up to {MAX_ALERT_ADDRESSES} addresses, separated by commas. Alert emails go only here."
			/>
		</label>
		{#if toError}<p class="error">{toError}</p>{/if}
		<div class="actions">
			<button
				type="button"
				class="btn btn-small"
				onclick={test}
				disabled={testing || !enabled || cleaned.length === 0 || !!toError}
				>{testing ? 'Sending…' : 'Send test'}</button
			>
			{#if testResult}<span class="help">{testResult}</span>{/if}
		</div>
		{#if testError}<p class="error">{testError}</p>{/if}
	{/if}
</section>

<style>
	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 8px 0 0;
	}

	.row {
		margin-top: 10px;
		font-size: 0.85rem;
	}

	.field {
		display: grid;
		grid-template-columns: 6rem 1fr;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		font-size: 0.85rem;
	}

	.field span {
		color: var(--text-secondary);
	}

	.field input,
	.field select {
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		min-width: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}

	.actions .help {
		margin: 0;
	}

	.error {
		margin: 6px 0 0;
		color: var(--error-text);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}
</style>
