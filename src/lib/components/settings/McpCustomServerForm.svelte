<script lang="ts" module>
	import type { EnvVar } from '#lib/stores/mcpSecrets.ts';

	export interface CustomServerForm {
		program: string;
		args: string[];
		env: EnvVar[];
	}

	/** The name a custom server gets from its program. */
	export function customServerLabel(program: string): string {
		return program.split(/[\\/]/).pop() || 'Custom server';
	}
</script>

<script lang="ts">
	/**
	 * A custom MCP server's program, arguments and secret variables: the form
	 * that adds one, and the one that edits it.
	 */
	import { untrack } from 'svelte';
	import { customEnvProblem } from '#lib/stores/mcpSecrets.ts';

	interface Props {
		program?: string;
		args?: string[];
		env?: EnvVar[];
		saveLabel: string;
		onsave: (form: CustomServerForm) => Promise<void>;
	}

	const { program = '', args = [], env = [], saveLabel, onsave }: Props = $props();

	// Seeded once from the props; the form owns them after that.
	let programText = $state(untrack(() => program));
	let argsText = $state(untrack(() => args.join(' ')));
	let rows = $state<EnvVar[]>(untrack(() => env.map((v) => ({ ...v }))));
	let saving = $state(false);
	const envError = $derived(customEnvProblem(rows));

	async function save(): Promise<void> {
		const p = programText.trim();
		if (!p || envError) return;
		saving = true;
		try {
			await onsave({
				program: p,
				args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
				// Plain copies: the rows are $state proxies.
				env: rows.map(({ name, value, kept }) => ({ name, value, kept }))
			});
		} finally {
			saving = false;
		}
	}
</script>

<div class="custom-form">
	<label>
		Program
		<input bind:value={programText} placeholder="/usr/local/bin/my-mcp-server" />
	</label>
	<label>
		Arguments
		<input
			bind:value={argsText}
			placeholder="--stdio"
			title="Saved in plain settings. Put keys in a secret variable instead."
		/>
	</label>
	{#each rows as envVar, i (i)}
		<div class="env-row">
			<input
				bind:value={envVar.name}
				placeholder="API_KEY"
				aria-label="Variable name"
				readonly={envVar.kept}
				title={envVar.kept ? 'To rename it, remove it and add a new one.' : undefined}
			/>
			<input
				type="password"
				bind:value={envVar.value}
				placeholder={envVar.kept ? 'Unchanged' : 'Value'}
				aria-label="Variable value"
				title="Kept in Haruspex's secret store and passed to the server as an environment variable."
			/>
			<button
				type="button"
				aria-label="Remove variable"
				onclick={() => (rows = rows.filter((_, j) => j !== i))}>×</button
			>
		</div>
	{/each}
	<button type="button" class="add-var" onclick={() => (rows = [...rows, { name: '', value: '' }])}
		>Add secret variable</button
	>
	{#if envError}
		<p class="error">{envError}</p>
	{/if}
	<button
		type="button"
		disabled={saving || !programText.trim() || !!envError}
		onclick={() => void save()}>{saveLabel}</button
	>
</div>

<style>
	.error {
		color: var(--danger, #ef4444);
		font-size: 0.9em;
	}
	.add-var {
		align-self: flex-start;
	}
	.env-row {
		display: flex;
		gap: 0.5rem;
	}
	.env-row input {
		flex: 1;
		min-width: 0;
	}
	.custom-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
</style>
