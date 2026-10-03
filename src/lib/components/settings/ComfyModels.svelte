<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen } from '@tauri-apps/api/event';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { getSettings } from '$lib/stores/settings';
	import type { ComfyModelFile } from '$lib/ipc/gen/ComfyModelFile';
	import type { ComfyModelSet } from '$lib/ipc/gen/ComfyModelSet';
	import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';
	import {
		chooseRoute,
		installDirect,
		installViaManager,
		managerRefusalHint,
		manualList,
		missingFiles,
		modelSets,
		type DitFamily,
		type InstallRoute,
		type ManagerApi
	} from '$lib/image/comfyui/provision';

	interface Props {
		/** Bumped by the parent after each probe, so the rows re-check. */
		probeCount: number;
		/** Ask the parent to probe again: a new model shows up in its list. */
		onInstalled: () => void;
	}
	let { probeCount, onInstalled }: Props = $props();

	interface Row {
		set: ComfyModelSet;
		missing: ComfyModelFile[];
	}

	let rows = $state<Row[]>([]);
	let route = $state<InstallRoute | null>(null);
	let manager = $state<ManagerApi | null>(null);
	let busy = $state<string | null>(null);
	let status = $state('');
	let error = $state('');

	const cfg = () => ({
		baseUrl: getSettings().imageBackendBaseUrl,
		apiKey: getSettings().imageBackendApiKey
	});

	async function refresh() {
		error = '';
		try {
			const sets = await modelSets();
			rows = await Promise.all(
				sets.map(async (set) => ({ set, missing: await missingFiles(cfg(), set) }))
			);
			({ route, manager } = await chooseRoute(cfg()));
		} catch (e) {
			rows = [];
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		void probeCount;
		void refresh();
	});

	function gb(bytes: number): string {
		return `${(bytes / 1e9).toFixed(1)} GB`;
	}

	function total(files: ComfyModelFile[]): number {
		return files.reduce((n, f) => n + f.size_bytes, 0);
	}

	const ROLE: Record<ComfyModelFile['folder'], string> = {
		diffusion_models: 'model',
		text_encoders: 'text encoder',
		vae: 'VAE'
	};

	const ROUTE_TIP: Record<InstallRoute, string> = {
		direct:
			"Downloads into ComfyUI's own model folders on this machine, checked against the publisher's checksum.",
		manager:
			'Queued with ComfyUI-Manager on the server, which downloads the files itself. It reports no progress.',
		manual:
			'Neither this machine nor ComfyUI-Manager can place the files; copy the list and put them in place.'
	};

	async function install(row: Row) {
		// Asked before anything downloads: the point is to stop gigabytes
		// arriving for a licence the user cannot use.
		if (!row.set.commercial_use) {
			const ok = window.confirm(
				`${row.set.license}\n\nThis model may not be used commercially. Install it anyway?`
			);
			if (!ok) return;
		}
		busy = row.set.family;
		error = '';
		status = 'Starting…';
		const unlisten = await listen<DownloadProgress>('download-progress', (e) => {
			const p = e.payload;
			status = `${p.stage} — ${gb(p.downloaded)} of ${gb(p.total)}`;
		});
		try {
			if (route === 'direct') {
				await installDirect(cfg(), row.set.family as DitFamily, getSettings().proxy);
			} else if (route === 'manager' && manager) {
				await installViaManager(cfg(), manager, row.missing, (f) => {
					status = `ComfyUI-Manager is downloading ${f}…`;
				});
				const still = await missingFiles(cfg(), row.set);
				if (still.length > 0) error = managerRefusalHint(cfg());
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			unlisten();
			busy = null;
			status = '';
			await refresh();
			onInstalled();
		}
	}

	async function cancel() {
		await invoke('cancel_download').catch(() => {});
	}

	async function copy(row: Row) {
		await navigator.clipboard.writeText(manualList(row.missing)).catch(() => {});
		status = 'Copied.';
	}
</script>

{#if rows.length > 0}
	<section class="settings-section">
		<h2>
			Models on the server
			{#if route}<Tooltip label="How models are installed" text={ROUTE_TIP[route]} />{/if}
		</h2>
		{#each rows as row (row.set.family)}
			<div class="model">
				<div class="model-head">
					<strong>{row.set.label}</strong>
					{#if row.missing.length === 0}<span class="badge">installed</span>{/if}
				</div>
				<p class="help">
					{row.set.license}
					<a href={row.set.license_url} target="_blank" rel="noreferrer">Full text</a>
				</p>
				{#if row.missing.length > 0}
					<p
						class="help"
						title={row.missing.map((f) => `models/${f.folder}/${f.filename}`).join('\n')}
					>
						Needs its {row.missing.map((f) => ROLE[f.folder]).join(', ')} ({gb(
							total(row.missing)
						)}).
					</p>
					<div class="actions">
						{#if route === 'manual'}
							<button onclick={() => copy(row)}>Copy file list</button>
						{:else if busy === row.set.family}
							{#if route === 'direct'}<button onclick={cancel}>Cancel</button>{/if}
						{:else}
							<button onclick={() => install(row)} disabled={busy !== null}>Install</button>
						{/if}
						{#if busy === row.set.family && status}<span class="detail">{status}</span>{/if}
					</div>
				{/if}
			</div>
		{/each}
		{#if error}<p class="warn">{error}</p>{/if}
	</section>
{/if}

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.detail {
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}
</style>
