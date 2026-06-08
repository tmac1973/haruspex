<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import {
		startServer,
		stopServer,
		getServerState,
		enterRemoteMode,
		exitRemoteMode
	} from '$lib/stores/server.svelte';
	import { PORTS } from '$lib/ports';
	import {
		getActiveLocalModelFilename,
		getSettings,
		updateSettings,
		updateInferenceBackend,
		getActiveContextSize,
		setActiveLocalModel,
		type InferenceBackendConfig,
		type InferenceMode
	} from '$lib/stores/settings';
	import { setContextSize as setIndicatorContextSize } from '$lib/stores/context.svelte';
	import InferenceBackendForm from '$lib/components/InferenceBackendForm.svelte';
	import ModelsSection from '$lib/components/settings/ModelsSection.svelte';

	const serverState = $derived(getServerState());
	let contextSize = $state(getSettings().contextSize);
	let inferenceBackend = $state<InferenceBackendConfig>(getSettings().inferenceBackend);

	const remoteMode = $derived(inferenceBackend.mode === 'remote');

	async function setInferenceMode(mode: InferenceMode) {
		if (mode === inferenceBackend.mode) return;
		inferenceBackend = { ...inferenceBackend, mode };
		updateInferenceBackend({ mode });
		// Refresh the header context indicator immediately so it reflects
		// the new backend's ceiling instead of the previous one's stale value.
		setIndicatorContextSize(getActiveContextSize());
		if (mode === 'remote') {
			// Stop the local llama-server sidecar — no point burning
			// VRAM on a model we're not going to query. Then flip the
			// server-store status to the synthetic 'remote' state so
			// the badge in the header updates.
			try {
				await stopServer();
			} catch (e) {
				console.warn('stopServer on remote toggle failed:', e);
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

	function setContextSize(size: number) {
		contextSize = size;
		updateSettings({ contextSize: size });
	}

	async function restartServer() {
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
		<label class="backend-mode-option" class:selected={!remoteMode}>
			<input
				type="radio"
				name="inference-mode"
				value="local"
				checked={!remoteMode}
				onchange={() => setInferenceMode('local')}
			/>
			<div>
				<strong>Local (Haruspex-managed)</strong>
				<span>llama-server sidecar with a model managed by Haruspex. Recommended.</span>
			</div>
		</label>
		<label class="backend-mode-option" class:selected={remoteMode}>
			<input
				type="radio"
				name="inference-mode"
				value="remote"
				checked={remoteMode}
				onchange={() => setInferenceMode('remote')}
			/>
			<div>
				<strong>Remote server (advanced)</strong>
				<span>Point at an existing OpenAI-compatible inference server.</span>
			</div>
		</label>
	</div>
	{#if remoteMode}
		<div class="remote-form-wrapper">
			<InferenceBackendForm config={inferenceBackend} onConfigChange={onInferenceConfigChange} />
		</div>
	{/if}
</section>

{#if !remoteMode}
	<ModelsSection />

	<section class="settings-section">
		<h2>Context Size</h2>
		<p class="hint">
			Larger context allows longer conversations but uses more VRAM. Requires server restart to take
			effect.
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
		{#if contextSize !== getSettings().contextSize}
			<p class="hint" style="color: var(--accent)">
				Restart the server for the new context size to take effect.
			</p>
		{/if}
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
				<button class="btn btn-danger" onclick={() => stopServer()}>Stop Server</button>
			{/if}
		</div>
	</section>
{/if}

<style>
	.hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin: 0 0 16px 0;
	}

	.backend-mode-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 12px;
	}

	.backend-mode-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.backend-mode-option:hover {
		border-color: var(--text-secondary);
	}

	.backend-mode-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.backend-mode-option input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.backend-mode-option strong {
		display: block;
		font-size: 0.9rem;
	}

	.backend-mode-option span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.remote-form-wrapper {
		margin-top: 4px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
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

	.btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.btn-danger {
		color: var(--error-text);
		border-color: var(--error-border);
	}

	.btn-danger:hover {
		background: var(--error-bg);
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
		color: #22c55e;
	}
	.status-value[data-status='starting'] {
		color: #eab308;
	}
	.status-value[data-status='error'] {
		color: var(--error-text);
	}
	.status-value[data-status='stopped'] {
		color: var(--text-secondary);
	}
</style>
