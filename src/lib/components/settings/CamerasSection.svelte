<script lang="ts">
	/**
	 * Settings → Cameras: the cameras the assistant can look and listen
	 * through, and the remote servers trusted with what they see and hear.
	 * One camera's form is open at a time and saves only on its Save.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import CameraForm from '#lib/components/settings/CameraForm.svelte';
	import CameraEventLog from '#lib/components/settings/CameraEventLog.svelte';
	import CameraAlertsSection from '#lib/components/settings/CameraAlertsSection.svelte';
	import { cameraWatchStatus } from '#lib/stores/cameraActivity.svelte.ts';
	import { isTrustableServer, trustedServerKey } from '#lib/camera/trust.ts';
	import { invalidateTypeAvailability } from '#lib/agent/jobs/types/availability.svelte.ts';
	import type { CameraConfig } from '#lib/ipc/gen/CameraConfig.ts';
	import { forgetCameraPassword } from '#lib/stores/cameraSecrets.ts';
	import {
		defaultWatcherConfig,
		getSettings,
		setCameraEventRetentionDays,
		setCameraTrustedServers,
		setCameras
	} from '#lib/stores/settings.ts';
	import { snapshot } from '#lib/utils/snapshot.ts';
	import { newId } from '#lib/utils/id.ts';
	import { defaultAlertConfig } from '#lib/camera/alertConfig.ts';

	/** The list as saved, read again after every change. */
	let cameras = $state<CameraConfig[]>(snapshot(getSettings().cameras));
	let openId = $state<string | null>(null);
	/** The camera whose Activity is shown. */
	let logId = $state<string | null>(null);
	let retentionDays = $state(getSettings().cameraEventRetentionDays);
	const watchErrors = $derived(cameraWatchStatus().errors);
	/** A camera added but not yet saved: dropped if its form is cancelled. */
	let pending = $state<CameraConfig | null>(null);
	const shown = $derived(pending ? [...cameras, pending] : cameras);

	/** Saved remote servers, as Settings → Inference lists them. */
	const servers = [
		...new Set(getSettings().inferenceBackend.remoteServerUrls.map(trustedServerKey))
	].filter(Boolean);
	let trusted = $state<string[]>(getSettings().cameraTrustedServers.map(trustedServerKey));

	function save(list: CameraConfig[]) {
		setCameras(list);
		cameras = snapshot(getSettings().cameras);
		// The Camera digest job type needs a camera set to Allow.
		invalidateTypeAvailability();
	}

	function blankCamera(): CameraConfig {
		return {
			id: newId('cam'),
			name: '',
			source: { kind: 'rtsp', url: '', substreamUrl: null, username: '', passwordRef: null },
			permission: 'ask',
			ptz: 'none',
			onvif: null,
			watcher: { ...defaultWatcherConfig },
			caps: null,
			alerts: { ...defaultAlertConfig }
		};
	}

	function add() {
		pending = blankCamera();
		openId = pending.id;
	}

	function toggle(id: string) {
		if (pending && openId === pending.id) pending = null;
		openId = openId === id ? null : id;
	}

	function toggleLog(id: string) {
		logId = logId === id ? null : id;
	}

	/** Days of the ambient log to keep, 1 to 90. */
	function setRetention(raw: number) {
		const days = Math.min(Math.max(Math.round(Number.isFinite(raw) ? raw : 7), 1), 90);
		retentionDays = days;
		setCameraEventRetentionDays(days);
	}

	function commit(next: CameraConfig) {
		const exists = cameras.some((c) => c.id === next.id);
		save(exists ? cameras.map((c) => (c.id === next.id ? next : c)) : [...cameras, next]);
		pending = null;
		openId = null;
	}

	function cancel() {
		pending = null;
		openId = null;
	}

	function remove(camera: CameraConfig) {
		void forgetCameraPassword($state.snapshot(camera) as CameraConfig);
		void invoke('camera_reference_clear', { cameraId: camera.id, light: null }).catch(() => {});
		save(cameras.filter((c) => c.id !== camera.id));
		if (openId === camera.id) openId = null;
		if (logId === camera.id) logId = null;
	}

	function where(c: CameraConfig): string {
		if (c.source.kind === 'usb') return 'USB';
		const host = c.source.url.replace(/^rtsps?:\/\//i, '').split('/')[0];
		return host ? `Network · ${host}` : 'Network';
	}

	function setTrusted(url: string, on: boolean) {
		const next = trusted.filter((u) => u !== url && servers.includes(u));
		if (on) next.push(url);
		trusted = next;
		setCameraTrustedServers([...next]);
		invalidateTypeAvailability();
	}
</script>

<section class="settings-section">
	<h2>Cameras</h2>
	<p
		class="help"
		title="The assistant takes a frame or a short clip only when asked. Frames and sound go to the local model, or to a server you trust below; never to OpenRouter."
	>
		Cameras the assistant can look and listen through when you ask.
	</p>
	{#if shown.length === 0}
		<p class="help">No cameras yet.</p>
	{/if}

	<ul class="entries">
		{#each shown as c (c.id)}
			<li class="entry" class:open={openId === c.id}>
				<div class="entry-head">
					<span class="entry-name">
						<strong>{c.name || 'New camera'}</strong>
						<span class="where">{where(c)}</span>
					</span>
					{#if c !== pending}
						<span
							class="badge"
							title={c.permission === 'ask'
								? 'Asks before each use.'
								: 'Used without asking, and by jobs.'}
						>
							{c.permission === 'ask' ? 'Ask' : 'Allow'}
						</span>
						<button
							class="btn btn-small"
							aria-expanded={logId === c.id}
							aria-label={`${c.name} activity`}
							title="Entries from the ambient log, newest first."
							onclick={() => toggleLog(c.id)}
						>
							Activity
						</button>
						<button
							class="btn btn-small"
							aria-expanded={openId === c.id}
							aria-label={`Edit ${c.name}`}
							onclick={() => toggle(c.id)}
						>
							Edit
						</button>
						<button class="btn btn-small" aria-label={`Remove ${c.name}`} onclick={() => remove(c)}>
							Remove
						</button>
					{/if}
				</div>
				{#if c !== pending && c.watcher.enabled && watchErrors[c.id]}
					<p class="error">Ambient log: {watchErrors[c.id]}</p>
				{/if}
				{#if logId === c.id && c !== pending}
					<div class="editor">
						<CameraEventLog cameraId={c.id} cameraName={c.name} />
					</div>
				{/if}
				{#if openId === c.id}
					<div class="editor">
						{#key c.id}
							<CameraForm
								camera={$state.snapshot(c) as CameraConfig}
								otherNames={cameras.filter((o) => o.id !== c.id).map((o) => o.name)}
								onSave={commit}
								onCancel={cancel}
							/>
						{/key}
					</div>
				{/if}
			</li>
		{/each}
	</ul>

	{#if !pending}
		<div class="actions">
			<button class="btn" onclick={add}>Add camera</button>
		</div>
	{/if}
</section>

<section class="settings-section">
	<h2>Ambient log</h2>
	<p
		class="help"
		title="Entries older than this are deleted with their pictures. Turn the log on for a camera under Edit."
	>
		How long to keep what the cameras log.
	</p>
	<label class="retention">
		<span>Keep entries for</span>
		<input
			type="number"
			min="1"
			max="90"
			value={retentionDays}
			onchange={(e) => setRetention(e.currentTarget.valueAsNumber)}
		/>
		<span>days</span>
	</label>
</section>

<CameraAlertsSection />

<section class="settings-section">
	<h2>Trusted servers</h2>
	<p
		class="help"
		title="A remote model gets camera frames and sound only from a server marked here. Only servers on your own network can be marked: private, loopback or link-local addresses, or .local and .internal names."
	>
		Remote servers of your own that may see and hear your cameras.
	</p>
	{#if servers.length === 0}
		<p class="help">No remote servers saved. Settings → Inference adds one.</p>
	{/if}
	{#each servers as url (url)}
		{@const ok = isTrustableServer(url)}
		<label
			class="toggle-row server"
			title={ok ? undefined : 'Only servers on your own network can be trusted'}
		>
			<input
				type="checkbox"
				disabled={!ok}
				checked={ok && trusted.includes(url)}
				onchange={(e) => setTrusted(url, e.currentTarget.checked)}
			/>
			<span>{url}</span>
		</label>
	{/each}
</section>

<style>
	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 8px 0 0;
	}

	.entries {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.entry {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
	}

	.entry-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.entry-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.entry-name strong {
		white-space: nowrap;
	}

	.where {
		font-size: 0.85em;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.badge {
		font-size: 0.75rem;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--accent-soft);
		color: var(--accent);
	}

	.editor {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.actions {
		margin-top: 10px;
	}

	.error {
		margin: 6px 0 0;
		color: var(--error-text);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}

	.retention {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
		font-size: 0.85rem;
	}

	.retention input {
		width: 5em;
		padding: 5px 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.server {
		margin-top: 10px;
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}

	.server:has(input:disabled) {
		cursor: not-allowed;
		color: var(--text-muted);
	}
</style>
