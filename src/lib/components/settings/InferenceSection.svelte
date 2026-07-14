<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import {
		startServer,
		stopServer,
		getServerState,
		enterRemoteMode,
		exitRemoteMode,
		restartServerWhenIdle,
		getPendingRestart,
		cancelPendingRestart
	} from '$lib/stores/server.svelte';
	import { PORTS } from '$lib/ports';
	import {
		getActiveLocalModelFilename,
		getSettings,
		updateSettings,
		updateInferenceBackend,
		setActiveLocalModel,
		type InferenceBackendConfig,
		type InferenceMode
	} from '$lib/stores/settings';
	import { resolveBackendDescriptor } from '$lib/inference/descriptor';
	import { setContextSize as setIndicatorContextSize } from '$lib/stores/context.svelte';
	import { showToast } from '$lib/stores/toasts.svelte';
	import { openLogViewer } from '$lib/stores/logViewer.svelte';
	import { errMessage } from '$lib/utils/error';
	import InferenceBackendForm from '$lib/components/InferenceBackendForm.svelte';
	import ModeSelector from '$lib/components/ModeSelector.svelte';
	import OpenRouterForm from '$lib/components/settings/OpenRouterForm.svelte';
	import ApiKeysSection from '$lib/components/settings/ApiKeysSection.svelte';
	import { OPENROUTER_BASE_URL } from '$lib/openrouter';
	import ModelsSection from '$lib/components/settings/ModelsSection.svelte';

	const serverState = $derived(getServerState());
	let contextSize = $state(getSettings().contextSize);
	let inferenceBackend = $state<InferenceBackendConfig>(getSettings().inferenceBackend);

	const remoteMode = $derived(inferenceBackend.mode === 'remote');
	const openrouterMode = $derived(
		remoteMode && inferenceBackend.remoteBackendKind === 'openrouter'
	);
	const genericRemoteMode = $derived(remoteMode && !openrouterMode);
	const pendingRestart = $derived(getPendingRestart());

	/** Server stop/start failure → error toast with a View-logs action.
	 *  The console.warn stays as the Log Viewer / devtools trail. */
	function toastServerFailure(verb: 'start' | 'stop', e: unknown) {
		showToast(`Couldn't ${verb} the inference server: ${errMessage(e)}`, {
			kind: 'error',
			actionLabel: 'View logs',
			onAction: openLogViewer
		});
	}

	/**
	 * The three UI-level backend choices. OpenRouter reuses `mode: 'remote'`
	 * internally (the transport is identical) but gets its own radio option +
	 * dedicated form; selecting it pins `remoteBaseUrl` to OpenRouter and
	 * `remoteBackendKind` to `'openrouter'` so the rest of the app knows to
	 * inject attribution headers and the `reasoning.effort` param.
	 */
	type ModeChoice = InferenceMode | 'openrouter';

	async function setInferenceMode(mode: ModeChoice) {
		if (mode === 'local' && inferenceBackend.mode === 'local') return;
		if (mode === 'remote' && genericRemoteMode) return;
		if (mode === 'openrouter' && openrouterMode) return;

		if (mode === 'openrouter') {
			// OpenRouter is a remote backend with a fixed URL + cloud kind.
			const next: InferenceBackendConfig = {
				...inferenceBackend,
				mode: 'remote',
				remoteBaseUrl: OPENROUTER_BASE_URL,
				remoteBackendKind: 'openrouter',
				allowParallelInference: true
			};
			inferenceBackend = next;
			updateInferenceBackend(next);
			setIndicatorContextSize(resolveBackendDescriptor().contextSize);
			cancelPendingRestart();
			try {
				await stopServer();
			} catch (e) {
				console.warn('stopServer on openrouter toggle failed:', e);
				toastServerFailure('stop', e);
			}
			enterRemoteMode(next.remoteBaseUrl, next.remoteModelId);
			return;
		}

		// local or generic-remote: clear the OpenRouter kind so the generic
		// remote form's probe-detection path takes over again.
		const cleared: InferenceBackendConfig = {
			...inferenceBackend,
			mode,
			...(mode === 'remote' ? { remoteBackendKind: null } : {})
		};
		inferenceBackend = cleared;
		updateInferenceBackend({ mode, ...(mode === 'remote' ? { remoteBackendKind: null } : {}) });
		// Refresh the header context indicator immediately so it reflects
		// the new backend's ceiling instead of the previous one's stale value.
		setIndicatorContextSize(resolveBackendDescriptor().contextSize);
		if (mode === 'remote') {
			// Drop any queued local restart — we're leaving local mode, so a
			// deferred model/context restart would otherwise fire later and
			// resurrect the local sidecar we're about to shut down.
			cancelPendingRestart();
			// Stop the local llama-server sidecar — no point burning
			// VRAM on a model we're not going to query. Then flip the
			// server-store status to the synthetic 'remote' state so
			// the badge in the header updates.
			try {
				await stopServer();
			} catch (e) {
				console.warn('stopServer on remote toggle failed:', e);
				toastServerFailure('stop', e);
			}
			enterRemoteMode(inferenceBackend.remoteBaseUrl, inferenceBackend.remoteModelId);
		} else {
			// Flipping back to local: leave the synthetic 'remote' state
			// and spin the local sidecar up with the currently-selected
			// model + configured context size. If no model is downloaded
			// yet, the layout's first-run redirect will kick in instead.
			exitRemoteMode();
			try {
				const modelPath = await invoke<string | null>('get_active_model_path', {
					preferredFilename: getActiveLocalModelFilename() || null
				});
				if (modelPath) {
					setActiveLocalModel(modelPath);
					await startServer(modelPath, getSettings().contextSize);
				}
			} catch (e) {
				console.warn('startServer on local toggle failed:', e);
				toastServerFailure('start', e);
			}
		}
	}

	function onInferenceConfigChange(next: InferenceBackendConfig) {
		inferenceBackend = next;
		updateInferenceBackend(next);
		// If we're already in remote mode, keep the header label in sync
		// with the (possibly just-changed) base URL or model id.
		if (next.mode === 'remote') {
			enterRemoteMode(next.remoteBaseUrl, next.remoteModelId);
		}
	}

	// Wrapper so OpenRouterForm can reuse the same commit path.
	function onOpenRouterConfigChange(next: InferenceBackendConfig) {
		onInferenceConfigChange(next);
	}

	async function setContextSize(size: number) {
		if (size === contextSize) return;
		contextSize = size;
		updateSettings({ contextSize: size });
		// A running server only picks up a new context window on restart. Do it
		// automatically — but defer it if a turn is in flight so we don't abort
		// the user's response mid-stream (restartServerWhenIdle queues it and
		// the banner below shows it's waiting). If the server isn't running,
		// there's nothing to restart; the new size applies on the next start.
		if (serverState.status !== 'ready' && serverState.status !== 'starting') return;
		const modelPath = await invoke<string | null>('get_active_model_path', {
			preferredFilename: getActiveLocalModelFilename() || null
		});
		if (modelPath) {
			setActiveLocalModel(modelPath);
			await restartServerWhenIdle(modelPath, size, 'context');
		}
	}

	// Explicit Restart — acts immediately and supersedes any queued restart.
	async function restartServer() {
		cancelPendingRestart();
		const modelPath = await invoke<string | null>('get_active_model_path', {
			preferredFilename: getActiveLocalModelFilename() || null
		});
		if (modelPath) {
			setActiveLocalModel(modelPath);
			await stopServer();
			await startServer(modelPath, getSettings().contextSize);
			invoke('tts_initialize').catch(() => {});
		}
	}

	// Explicit Stop — acts immediately and cancels any queued restart so the
	// server doesn't spring back to life after the user deliberately stopped it.
	function stopServerNow() {
		cancelPendingRestart();
		void stopServer();
	}
</script>

<section class="settings-section">
	<h2>Inference backend</h2>
	<p class="hint">
		Haruspex normally manages its own llama-server sidecar with a downloaded model. If you already
		run an inference server (LM Studio, Lemonade, Ollama, llama.cpp, llama-toolchest, vLLM, TGI,
		etc.) you can point Haruspex at it instead — the local sidecar will shut down and chat requests
		will route to your server.
	</p>
	<div class="backend-mode-row">
		<ModeSelector
			name="inference-mode"
			value={openrouterMode ? 'openrouter' : genericRemoteMode ? 'remote' : 'local'}
			onchange={(mode) => setInferenceMode(mode)}
			options={[
				{
					value: 'local',
					title: 'Local (Haruspex-managed)',
					description: 'llama-server sidecar with a model managed by Haruspex. Recommended.'
				},
				{
					value: 'remote',
					title: 'Remote server (advanced)',
					description: 'Point at an existing OpenAI-compatible inference server.'
				},
				{
					value: 'openrouter',
					title: 'OpenRouter (cloud)',
					description:
						"Cloud model router — your prompts leave your device and go to OpenRouter's servers."
				}
			]}
		/>
	</div>
	{#if genericRemoteMode}
		<div class="remote-form-wrapper">
			<InferenceBackendForm config={inferenceBackend} onConfigChange={onInferenceConfigChange} />
		</div>
	{:else if openrouterMode}
		<div class="remote-form-wrapper">
			<OpenRouterForm config={inferenceBackend} onConfigChange={onOpenRouterConfigChange} />
		</div>
	{/if}

	{#if remoteMode}
		<ApiKeysSection />
	{/if}
</section>

{#if !remoteMode}
	{#if pendingRestart}
		<div class="restart-banner" role="status">
			<span class="spinner restart-spinner" aria-hidden="true"></span>
			<span class="restart-text">
				{pendingRestart.reason === 'model' ? 'Model change' : 'Context size change'} queued — the server
				will restart automatically once the in-progress response finishes.
			</span>
			<button class="btn btn-small" onclick={cancelPendingRestart}>Cancel</button>
		</div>
	{/if}

	<ModelsSection />

	<section class="settings-section">
		<h2>Context Size</h2>
		<p class="hint">
			Larger context allows longer conversations but uses more VRAM. Changing this restarts the
			server automatically to load the new context window — deferred until any in-progress response
			finishes.
		</p>
		<div class="context-options">
			{#each [{ value: 8192, label: '8K', desc: 'Low VRAM' }, { value: 16384, label: '16K', desc: 'Standard' }, { value: 32768, label: '32K', desc: 'Recommended' }, { value: 65536, label: '64K', desc: '16+ GB VRAM' }, { value: 131072, label: '128K', desc: 'Maximum' }] as opt (opt.value)}
				<button
					class="ctx-btn"
					class:selected={contextSize === opt.value}
					onclick={() => setContextSize(opt.value)}
				>
					<strong>{opt.label}</strong>
					<span>{opt.desc}</span>
				</button>
			{/each}
		</div>
	</section>

	<section class="settings-section">
		<h2>Server</h2>
		<div class="info-row">
			<span>Status</span>
			<span class="status-value" data-status={serverState.status}>{serverState.status}</span>
		</div>
		<div class="info-row">
			<span>Port</span>
			<span>{PORTS.llama}</span>
		</div>
		<div class="server-actions">
			{#if serverState.status === 'ready' || serverState.status === 'error'}
				<button class="btn btn-primary" onclick={restartServer}>Restart Server</button>
			{:else if serverState.status === 'stopped'}
				<button class="btn btn-primary" onclick={restartServer}>Start Server</button>
			{:else}
				<button class="btn" disabled>Starting...</button>
			{/if}
			{#if serverState.status === 'ready' || serverState.status === 'starting'}
				<button class="btn btn-danger" onclick={stopServerNow}>Stop Server</button>
			{/if}
		</div>
	</section>

	<ApiKeysSection />
{/if}

<style>
	.hint {
		margin: 0 0 16px 0;
	}

	.backend-mode-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 12px;
	}

	.remote-form-wrapper {
		margin-top: 4px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-raised);
	}

	.restart-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 16px;
		padding: 10px 14px;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		font-size: 0.82rem;
		color: var(--text-primary);
	}

	.restart-text {
		flex: 1;
	}

	/* Layout override of the global .spinner inside the flex banner. */
	.restart-spinner {
		flex: none;
	}

	.context-options {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.ctx-btn {
		flex: 1;
		min-width: 80px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		text-align: center;
	}

	.ctx-btn:hover {
		border-color: var(--text-secondary);
	}

	.ctx-btn.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.ctx-btn strong {
		display: block;
		font-size: 0.95rem;
	}

	.ctx-btn span {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.server-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		font-size: 0.9rem;
	}

	.status-value[data-status='ready'] {
		color: var(--success);
	}
	.status-value[data-status='starting'] {
		color: var(--warning);
	}
	.status-value[data-status='error'] {
		color: var(--error-text);
	}
	.status-value[data-status='stopped'] {
		color: var(--text-secondary);
	}
</style>
