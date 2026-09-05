<script lang="ts">
	/**
	 * Runs a catalog entry's guided setup, one step at a time.
	 *
	 * Renders the four step kinds generically — adding a server to the catalog
	 * must never require a code change, so nothing here knows what GitHub or
	 * Google are. Progress is persisted after every step (see `mcpSetup.ts`):
	 * Google's OAuth detour takes long enough that people close the app in the
	 * middle of it, and restarting from step one is where they give up.
	 */
	import { untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
	import { IPC } from '$lib/ipc/commands';
	import type { SetupStep } from '$lib/ipc/gen/SetupStep';
	import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
	import {
		clearSetupProgress,
		isSetupComplete,
		isStepSatisfied,
		resumeIndex,
		saveStepIndex,
		setupStateOf,
		stepLabel
	} from '$lib/stores/mcpSetup';

	interface Props {
		config: McpServerConfig;
		steps: SetupStep[];
		onchange: (next: McpServerConfig) => void;
		ondone: () => void;
		oncancel: () => void;
	}

	const { config, steps, onchange, ondone, oncancel }: Props = $props();

	let filesPlaced = $state<string[]>([]);
	let commandsRun = $state<number[]>([]);
	// Computed once, deliberately. Recomputing as the user fills a secret in
	// would move the wizard under them mid-keystroke, which is why the props
	// are read untracked rather than through a derived.
	let index = $state(untrack(() => resumeIndex(steps, config.id, setupStateOf(config, [], []))));
	let commandOutput = $state('');
	let running = $state(false);
	let error = $state<string | null>(null);

	const setupState = $derived(setupStateOf(config, filesPlaced, commandsRun));
	const step = $derived(steps[index] ?? null);
	const canAdvance = $derived(step !== null && isStepSatisfied(step, setupState, index));
	const complete = $derived(isSetupComplete(steps, setupState));

	function setSecret(key: string, value: string): void {
		onchange({ ...config, secrets: { ...config.secrets, [key]: value } });
	}

	function advance(): void {
		const next = index + 1;
		index = next;
		saveStepIndex(config.id, next);
		if (next >= steps.length) finish();
	}

	function back(): void {
		index = Math.max(0, index - 1);
		saveStepIndex(config.id, index);
	}

	function finish(): void {
		// setupComplete is what makes the server startable at all, so it is set
		// from the same check the wizard shows — not from "the user reached the
		// last screen", which they can do with a step left unsatisfied behind
		// them if settings changed underneath.
		onchange({ ...config, setupComplete: isSetupComplete(steps, setupState) });
		clearSetupProgress(config.id);
		ondone();
	}

	async function pickFile(filename: string): Promise<void> {
		error = null;
		try {
			const picked = await openFileDialog({ multiple: false, directory: false });
			if (typeof picked !== 'string') return;
			await invoke(IPC.mcp_place_setup_file, {
				serverId: config.id,
				sourcePath: picked,
				filename
			});
			filesPlaced = [...filesPlaced, filename];
		} catch (e) {
			error = String(e);
		}
	}

	async function runCommand(args: string[]): Promise<void> {
		error = null;
		running = true;
		commandOutput = '';
		try {
			commandOutput = await invoke<string>(IPC.mcp_run_setup_command, {
				config,
				args
			});
			commandsRun = [...commandsRun, index];
		} catch (e) {
			error = String(e);
			commandOutput = String(e);
		} finally {
			running = false;
		}
	}
</script>

<div class="wizard">
	<ol class="steps">
		{#each steps as s, i (i)}
			<li class:done={i < index} class:current={i === index}>{stepLabel(s)}</li>
		{/each}
	</ol>

	{#if step}
		<div class="step-body">
			{#if step.kind === 'instruction'}
				<h4>{step.title}</h4>
				<p>{step.text}</p>
				{#if step.link}
					<button
						type="button"
						class="link-button"
						onclick={() => invoke(IPC.open_url, { url: step.link })}
					>
						Open in your browser
					</button>
				{/if}
			{:else if step.kind === 'secret'}
				<h4>{step.label}</h4>
				{#if step.help}<p class="help">{step.help}</p>{/if}
				<input
					type="password"
					value={config.secrets[step.key] ?? ''}
					oninput={(e) => setSecret(step.key, e.currentTarget.value)}
					placeholder={step.label}
				/>
			{:else if step.kind === 'file'}
				<h4>{step.label}</h4>
				{#if step.help}<p class="help">{step.help}</p>{/if}
				<button type="button" onclick={() => pickFile(step.filename)}>
					{filesPlaced.includes(step.filename) ? 'Choose a different file' : 'Choose file…'}
				</button>
				{#if filesPlaced.includes(step.filename)}
					<p class="help">Copied in as {step.filename}.</p>
				{/if}
			{:else if step.kind === 'command'}
				<h4>{step.label}</h4>
				{#if step.help}<p class="help">{step.help}</p>{/if}
				<button type="button" disabled={running} onclick={() => runCommand(step.args)}>
					{running ? 'Running…' : commandsRun.includes(index) ? 'Run again' : 'Run'}
				</button>
				{#if commandOutput}
					<pre class="output">{commandOutput}</pre>
				{/if}
			{/if}
		</div>
	{:else}
		<p>Setup finished.</p>
	{/if}

	{#if error}<p class="error">{error}</p>{/if}

	<div class="actions">
		<button type="button" onclick={oncancel}>Close</button>
		<button type="button" disabled={index === 0} onclick={back}>Back</button>
		{#if index >= steps.length - 1}
			<button type="button" disabled={!complete} onclick={finish}>Finish</button>
		{:else}
			<button type="button" disabled={!canAdvance} onclick={advance}>Next</button>
		{/if}
	</div>
	{#if !canAdvance && step}
		<p class="help">Fill this in to continue. Your progress is saved if you close the app.</p>
	{/if}
</div>

<style>
	.steps {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		list-style: none;
		padding: 0;
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
	.steps .current {
		color: var(--accent, #14b8a6);
		font-weight: 600;
	}
	.steps .done {
		text-decoration: line-through;
	}
	.step-body {
		margin: 0.75rem 0;
	}
	.help {
		font-size: 0.85em;
		color: var(--text-secondary, #a8a29e);
	}
	.error {
		color: var(--danger, #ef4444);
	}
	.output {
		max-height: 12rem;
		overflow: auto;
		font-size: 0.8em;
		white-space: pre-wrap;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.link-button {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #14b8a6);
		cursor: pointer;
	}
</style>
