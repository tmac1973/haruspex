<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { goto } from '$app/navigation';
	import {
		startServer,
		stopServer,
		getServerState,
		enterRemoteMode,
		exitRemoteMode,
		restartServerWhenIdle,
		getPendingRestart,
		cancelPendingRestart,
		type RestartReason
	} from '#lib/stores/llamaServer.svelte.ts';
	import { PORTS } from '#lib/ports.ts';
	import {
		getActiveLocalModelFilename,
		getSettings,
		updateSettings,
		updateInferenceBackend,
		setActiveLocalModel,
		type InferenceBackendConfig,
		type InferenceMode
	} from '#lib/stores/settings.ts';
	import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
	import { setContextSize as setIndicatorContextSize } from '#lib/stores/context.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { openLogViewer } from '#lib/stores/logViewer.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import InferenceBackendForm from '#lib/components/InferenceBackendForm.svelte';
	import ModeSelector from '#lib/components/ModeSelector.svelte';
	import OpenRouterForm from '#lib/components/settings/OpenRouterForm.svelte';
	import ApiKeysSection from '#lib/components/settings/ApiKeysSection.svelte';
	import { withRemoteOption } from '#lib/stores/remoteProfiles.ts';
	import { OPENROUTER_BASE_URL } from '#lib/openrouter.ts';
	import ModelsSection from '#lib/components/settings/ModelsSection.svelte';

	const serverState = $derived(getServerState());
	let contextSize = $state(getSettings().contextSize);
	let allowSpill = $state(getSettings().allowSpillToSystemRam);
	let projectorInRam = $state(getSettings().visionProjectorInSystemRam);
	let parallelSlots = $state(getSettings().localParallelSlots);
	let extraArgs = $state(getSettings().llamaServerExtraArgs);
	let inferenceBackend = $state<InferenceBackendConfig>(getSettings().inferenceBackend);

	// Predictive memory cap: detected total VRAM (MB) and the largest context the
	// active model fits in it — plus system RAM when models may use it. A `null`
	// ceiling means "can't predict" (unknown VRAM or an unrecognized model) — in
	// that case we leave every size selectable rather than ghosting choices we
	// can't reason about.
	let gpuVramMb = $state<number | null>(null);
	let ctxCeiling = $state<number | null>(null);

	function formatCtx(n: number): string {
		return n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}`;
	}

	/** Recompute the VRAM context ceiling for the currently-active local model.
	 *  Best-effort: any failure leaves the ceiling null (picker unrestricted). */
	async function refreshCtxCeiling() {
		const filename = getActiveLocalModelFilename();
		const modelId = filename ? filename.replace(/\.gguf$/i, '') : '';
		if (!modelId || gpuVramMb === null) {
			ctxCeiling = null;
			return;
		}
		try {
			ctxCeiling = await invoke<number | null>('context_fit_ceiling', {
				modelId,
				vramMb: gpuVramMb,
				// A CPU-resident projector isn't competing for VRAM, so it
				// doesn't count against the KV budget.
				mmprojOnCpu: projectorInRam,
				ramOffload: allowSpill,
				// Every stream holds the full context, so more streams lower it.
				parallel: parallelSlots
			});
		} catch {
			ctxCeiling = null;
		}
	}

	// On mount: detect VRAM, derive the ceiling, and snap a previously-saved
	// oversized context down to what actually fits.
	$effect(() => {
		void (async () => {
			try {
				const hw = await invoke<{ gpu_vram_mb: number | null }>('cmd_detect_hardware');
				gpuVramMb = hw.gpu_vram_mb ?? null;
			} catch {
				gpuVramMb = null;
			}
			await refreshCtxCeiling();
			if (ctxCeiling !== null && contextSize > ctxCeiling) {
				showToast(
					allowSpill
						? `${formatCtx(contextSize)} context needs more memory than this machine has — using ${formatCtx(ctxCeiling)}.`
						: `${formatCtx(contextSize)} context needs more VRAM than your GPU has — using ${formatCtx(ctxCeiling)}. Turn on "Let models use system RAM" below to keep the larger size.`,
					{ kind: 'info' }
				);
				await setContextSize(ctxCeiling);
			}
		})();
	});

	// The active model can change while this panel is open (Models section),
	// which restarts the server. Re-derive the ceiling when it comes back up so
	// the picker reflects the new model's VRAM footprint.
	$effect(() => {
		if (serverState.status === 'ready') {
			void refreshCtxCeiling();
		}
	});

	async function onToggleProjector(next: boolean) {
		projectorInRam = next;
		updateSettings({ visionProjectorInSystemRam: next });
		// The ceiling moves with the flag — the projector's VRAM either counts
		// against the KV budget or it doesn't — so re-derive before deciding
		// whether the current selection still fits.
		await refreshCtxCeiling();
		if (ctxCeiling !== null && contextSize > ctxCeiling) {
			// Moving the projector back onto the GPU shrank the budget. Snap
			// down like the spill toggle does; that restarts the server too,
			// so there's nothing left to do here.
			showToast(
				`${formatCtx(contextSize)} no longer fits with the projector in VRAM — using ${formatCtx(ctxCeiling)}.`,
				{ kind: 'info' }
			);
			await setContextSize(ctxCeiling);
			return;
		}
		await restartActiveModel('projector');
	}

	async function onToggleSpill(next: boolean) {
		allowSpill = next;
		updateSettings({ allowSpillToSystemRam: next });
		// The ceiling moves with the flag: system RAM either counts or it
		// doesn't.
		await refreshCtxCeiling();
		if (ctxCeiling !== null && contextSize > ctxCeiling) {
			// Turning it off with a selection only RAM could hold: snap down.
			// That restarts the server too, so there's nothing left to do.
			showToast(
				`${formatCtx(contextSize)} doesn't fit in VRAM alone — using ${formatCtx(ctxCeiling)}.`,
				{ kind: 'info' }
			);
			await setContextSize(ctxCeiling);
			return;
		}
		// The flag changes how llama-server places the model, so it only takes
		// effect on restart.
		await restartActiveModel('memory');
	}

	async function setParallelSlots(n: number) {
		if (n === parallelSlots) return;
		parallelSlots = n;
		updateSettings({ localParallelSlots: n });
		await refreshCtxCeiling();
		if (ctxCeiling !== null && contextSize > ctxCeiling) {
			showToast(
				`${n} streams of ${formatCtx(contextSize)} don't fit — using ${formatCtx(ctxCeiling)} each.`,
				{ kind: 'info' }
			);
			await setContextSize(ctxCeiling);
			return;
		}
		await restartActiveModel('parallel');
	}

	async function commitExtraArgs() {
		const next = extraArgs.trim();
		if (next === getSettings().llamaServerExtraArgs) return;
		extraArgs = next;
		updateSettings({ llamaServerExtraArgs: next });
		await restartActiveModel('arguments');
	}

	// The Rust supervisor may back the context size down during startup
	// (context-backoff: the configured size didn't fit in memory). The
	// server store already persisted the smaller size; mirror it into the
	// picker so the selected button matches what the server is running.
	$effect(() => {
		const backoff = serverState.ctxBackoff;
		if (backoff && contextSize !== backoff.to) {
			contextSize = backoff.to;
		}
	});

	const remoteMode = $derived(inferenceBackend.mode === 'remote');
	const openrouterMode = $derived(
		remoteMode && inferenceBackend.remoteBackendKind === 'openrouter'
	);
	const genericRemoteMode = $derived(remoteMode && !openrouterMode);
	const pendingRestart = $derived(getPendingRestart());

	function restartReasonLabel(reason: RestartReason): string {
		if (reason === 'model') return 'Model change';
		if (reason === 'projector') return 'Vision projector change';
		if (reason === 'memory') return 'System RAM change';
		if (reason === 'parallel') return 'Parallel streams change';
		if (reason === 'arguments') return 'Server arguments change';
		return 'Context size change';
	}

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
			// OpenRouter's own URL, key and model come back; the Remote
			// option's are filed away until it is picked again.
			const next: InferenceBackendConfig = {
				...withRemoteOption(inferenceBackend, 'openrouter'),
				mode: 'remote',
				remoteBaseUrl: OPENROUTER_BASE_URL,
				remoteBackendKind: 'openrouter'
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

		// Local keeps the remote fields as they are. Generic Remote gets its
		// own server, key and model back from before OpenRouter was picked.
		const cleared: InferenceBackendConfig = {
			...(mode === 'remote' ? withRemoteOption(inferenceBackend, 'generic') : inferenceBackend),
			mode
		};
		inferenceBackend = cleared;
		updateInferenceBackend(cleared);
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

	/** Restart the running server against the active model so a changed
	 *  server-side flag takes effect. Deferred if a turn is in flight so we
	 *  don't abort the user's response mid-stream (restartServerWhenIdle
	 *  queues it and the banner above shows it's waiting). A no-op when the
	 *  server isn't running — the change applies on the next start. */
	async function restartActiveModel(reason: Exclude<RestartReason, 'model'>) {
		if (serverState.status !== 'ready' && serverState.status !== 'starting') return;
		const modelPath = await invoke<string | null>('get_active_model_path', {
			preferredFilename: getActiveLocalModelFilename() || null
		});
		if (!modelPath) return;
		setActiveLocalModel(modelPath);
		await restartServerWhenIdle(modelPath, contextSize, reason);
	}

	async function setContextSize(size: number) {
		if (size === contextSize) return;
		contextSize = size;
		updateSettings({ contextSize: size });
		// A running server only picks up a new context window on restart.
		await restartActiveModel('context');
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
				{restartReasonLabel(pendingRestart.reason)} queued — the server will restart automatically once
				the in-progress response finishes.
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
			{#each [{ value: 8192, label: '8K', desc: 'Low VRAM' }, { value: 16384, label: '16K', desc: 'Standard' }, { value: 32768, label: '32K', desc: 'Recommended' }, { value: 65536, label: '64K', desc: '16+ GB VRAM' }, { value: 131072, label: '128K', desc: '24+ GB VRAM' }, { value: 262144, label: '256K', desc: 'Maximum' }] as opt (opt.value)}
				{@const overCeiling = ctxCeiling !== null && opt.value > ctxCeiling}
				<button
					class="ctx-btn"
					class:selected={contextSize === opt.value}
					class:over-ceiling={overCeiling}
					disabled={overCeiling}
					title={overCeiling
						? allowSpill
							? "Exceeds your GPU's VRAM and spare system RAM together."
							: "Exceeds your GPU's VRAM. Turn on “Let models use system RAM” to use this size."
						: undefined}
					onclick={() => setContextSize(opt.value)}
				>
					<strong>{opt.label}</strong>
					<span
						>{overCeiling ? (allowSpill ? 'Needs more memory' : 'Needs more VRAM') : opt.desc}</span
					>
				</button>
			{/each}
		</div>
		<label class="inference-toggle">
			<input
				type="checkbox"
				checked={allowSpill}
				onchange={(e) => void onToggleSpill(e.currentTarget.checked)}
			/>
			<span
				class="toggle-label"
				title="llama.cpp keeps what it can in VRAM and moves the rest to system RAM. Mixture-of-experts models such as Qwen 3.6 35B-A3B lose the least speed, because only a few experts run per token. Dense models slow down a lot."
			>
				Let models use system RAM
				<span class="toggle-sub">
					Runs bigger models and contexts than your VRAM holds, more slowly. Off by default;
					restarts the server.
				</span>
			</span>
		</label>
		<label class="inference-toggle">
			<input
				type="checkbox"
				checked={projectorInRam}
				onchange={(e) => void onToggleProjector(e.currentTarget.checked)}
			/>
			<span class="toggle-label">
				Keep the vision projector in system RAM
				<span class="toggle-sub">
					Frees the ~1 GB the image encoder holds in VRAM all session, usually buying a larger
					context. Only turns that contain an image pay for it, and they get slower. Off by default;
					restarts the server.
				</span>
			</span>
		</label>

		<div
			class="sub-setting"
			title="Each stream gets the whole context size, so 2 streams need twice the memory for context and some sizes may grey out. Streams share the GPU, so each reply is slower while another runs."
		>
			<span class="toggle-label">
				Parallel streams
				<span class="toggle-sub">
					Lets a background job run beside chat. 1 by default; restarts the server.
				</span>
			</span>
			<div class="stream-options">
				{#each [1, 2, 4] as n (n)}
					<button
						class="ctx-btn stream-btn"
						class:selected={parallelSlots === n}
						onclick={() => void setParallelSlots(n)}
					>
						<strong>{n}</strong>
					</button>
				{/each}
			</div>
		</div>

		<label class="sub-setting extra-args">
			<span
				class="toggle-label"
				title="Passed to llama-server after Haruspex's own arguments, so these override them. Quotes group an argument; backslashes are kept as typed. Takes effect on restart."
			>
				Extra llama-server arguments
				<span class="toggle-sub">For advanced users. Empty by default; restarts the server.</span>
			</span>
			<input
				type="text"
				spellcheck="false"
				autocomplete="off"
				placeholder="--n-cpu-moe 10"
				bind:value={extraArgs}
				onchange={() => void commitExtraArgs()}
			/>
		</label>
	</section>

	<section class="settings-section">
		<h2>Server</h2>
		<div class="info-row">
			<span>Status</span>
			<span class="status-value" data-status={serverState.status}>{serverState.status}</span>
		</div>
		{#if serverState.status === 'error' && extraArgs.trim()}
			<p class="hint">
				Extra llama-server arguments are set ({extraArgs.trim()}). If the server won't start, clear
				Settings → Inference → Extra llama-server arguments.
			</p>
		{/if}
		<div class="info-row">
			<span>Port</span>
			<span>{PORTS.llama}</span>
		</div>
		<div class="server-actions">
			<button
				class="btn"
				title="Re-run first-run setup: hardware detection, model choice and the test query. Your existing models and settings are left alone unless you change them there."
				onclick={() => goto('/setup')}
			>
				Run Setup Wizard
			</button>
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

	.ctx-btn.over-ceiling {
		opacity: 0.45;
		cursor: not-allowed;
		border-style: dashed;
	}

	.ctx-btn.over-ceiling:hover {
		border-color: var(--border);
	}

	.inference-toggle {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-top: 12px;
		cursor: pointer;
	}

	.inference-toggle input {
		margin-top: 2px;
		flex-shrink: 0;
	}

	.toggle-label {
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.sub-setting {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 16px;
	}

	.stream-options {
		display: flex;
		gap: 8px;
	}

	.stream-btn {
		min-width: 56px;
	}

	.extra-args input {
		width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.85rem;
	}

	.toggle-sub {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
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
