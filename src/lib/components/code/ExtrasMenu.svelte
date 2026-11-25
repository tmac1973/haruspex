<script lang="ts">
	/**
	 * The session header's Extras menu: which helpers (Settings → Code →
	 * Helpers) this session offers its agent, and, with the 3D helper on, the
	 * model its `delegate_3d` hands work to. Hidden while there are no helpers.
	 * Applies from the next turn.
	 */
	import type { BackendOverride } from '#lib/api.ts';
	import { helpers, sessionHelpers } from '#lib/helpers/registry.ts';
	import '#lib/helpers/index.ts';
	import DelegateModelPicker from '#lib/helpers/three/DelegateModelPicker.svelte';
	import {
		delegate3dConfig,
		sessionDelegateBackend,
		withSessionDelegate
	} from '#lib/helpers/three/delegateConfig.ts';
	import { overrideModelLabel } from '#lib/code/backends.ts';
	import type { SessionHelperConfig } from '#lib/code/db.ts';
	import type { CodeSessionView } from '#lib/code/sessionView.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSessionView } = $props();

	// Read live so the menu follows Settings → Code.
	const settings = $derived(getLiveSettings());
	const helperList = helpers();
	const helpersOn = $derived.by(() => {
		void settings;
		return new Set(sessionHelpers(session.helpers ?? null).map((h) => h.id));
	});
	const count = $derived(helpersOn.size);
	const custom = $derived((session.helpers ?? null) !== null);

	let open = $state(false);
	let wrap = $state<HTMLElement>();

	// The 3D delegate: the session's own model (null: none here), else Settings'.
	const has3d = $derived(helpersOn.has('3d') && !!session.setSessionHelperConfig);
	const ownDelegate = $derived(sessionDelegateBackend(session.helperConfig ?? null));
	const delegate = $derived.by(() => {
		void settings;
		return delegate3dConfig(session.helperConfig ?? null).backend;
	});
	const delegateLabel = $derived(delegate ? overrideModelLabel(delegate).label : 'None');
	let picking = $state(false);

	/** A model or null (none) for this session; undefined goes back to Settings. */
	async function storeDelegate(backend: BackendOverride | null | undefined) {
		picking = false;
		const current = $state.snapshot(session.helperConfig ?? null) as SessionHelperConfig | null;
		try {
			await session.setSessionHelperConfig?.(withSessionDelegate(current, backend));
		} catch (e) {
			showToast(`Couldn't change the 3D delegate: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function openPicker() {
		open = false;
		picking = true;
	}

	async function store(ids: string[] | null) {
		try {
			await session.setSessionHelpers?.(ids);
		} catch (e) {
			showToast(`Couldn't change the helpers: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function toggleHelper(id: string, on: boolean) {
		const next = helperList
			.filter((h) => (h.id === id ? on : helpersOn.has(h.id)))
			.map((h) => h.id);
		void store(next);
	}

	async function useDefaults() {
		if (session.helpers !== null) await store(null);
	}

	function closeOutside(e: MouseEvent) {
		if (open && wrap && !wrap.contains(e.target as Node)) open = false;
	}
</script>

<svelte:window onclick={closeOutside} />

{#if helperList.length > 0}
	<span class="wrap" bind:this={wrap}>
		<button
			class="pick"
			aria-expanded={open}
			title="Helpers the agent can use. Applies from the next message."
			onclick={() => (open = !open)}
		>
			Extras: {count} ▾
		</button>
		{#if open}
			<div class="panel" role="dialog" aria-label="Extras">
				{#if helperList.length > 0}
					<div class="heading" title="Tools that run without a model (Settings → Code → Helpers).">
						Helpers
					</div>
					{#each helperList as h (h.id)}
						<label
							class="item"
							title={h.writes && session.readOnly ? 'This session is read-only.' : h.tooltip}
						>
							<input
								type="checkbox"
								checked={helpersOn.has(h.id)}
								disabled={session.busy || (h.writes && session.readOnly)}
								onchange={(ev) => toggleHelper(h.id, ev.currentTarget.checked)}
							/>
							<span>{h.label}</span>
						</label>
					{/each}
				{/if}
				{#if has3d}
					<div class="heading" title="The model delegate_3d hands 3D assets to in this session.">
						3D delegate
					</div>
					<div class="delegate">
						<span
							class="delegate-model"
							title={ownDelegate === undefined
								? 'From Settings → Code → Helpers → 3D.'
								: 'Set for this session only.'}
						>
							{delegateLabel}{ownDelegate === undefined ? '' : ' · this session'}
						</span>
						<button class="change" onclick={openPicker}>Change…</button>
					</div>
				{/if}
				<button
					class="defaults"
					disabled={session.busy || !custom}
					title="The helpers switched on in Settings → Code → Helpers."
					onclick={() => void useDefaults()}
				>
					Use defaults
				</button>
			</div>
		{/if}
	</span>
	{#if picking}
		<DelegateModelPicker
			title="3D delegate for this session"
			current={ownDelegate}
			onchoose={(b) => void storeDelegate(b)}
			onusesettings={() => void storeDelegate(undefined)}
			onclose={() => (picking = false)}
		/>
	{/if}
{/if}

<style>
	.wrap {
		position: relative;
	}

	.pick {
		padding: 3px 6px;
		font-size: 0.76rem;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		cursor: pointer;
		white-space: nowrap;
	}

	.panel {
		position: absolute;
		left: 0;
		top: calc(100% + 6px);
		z-index: 50;
		min-width: 200px;
		max-height: 360px;
		overflow-y: auto;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
	}

	.heading {
		padding: 4px 6px 2px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
	}

	.heading:not(:first-child) {
		margin-top: 4px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		border-radius: 5px;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.item:hover {
		background: var(--bg-secondary);
	}

	.delegate {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
		font-size: 0.8rem;
	}

	.delegate-model {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.change {
		padding: 2px 6px;
		font-size: 0.74rem;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: var(--bg-input);
		color: var(--text-primary);
		cursor: pointer;
	}

	.defaults {
		margin-top: 4px;
		padding: 4px 6px;
		font-size: 0.76rem;
		text-align: left;
		background: none;
		border: none;
		border-top: 1px solid var(--border);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.defaults:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
