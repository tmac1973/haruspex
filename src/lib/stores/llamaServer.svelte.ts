import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SidecarStatus } from '#lib/ipc/gen/SidecarStatus.ts';
import type { ContextBackoffState } from '#lib/ipc/gen/ContextBackoffState.ts';
import { PORTS } from '#lib/ports.ts';
import { isOpenRouterUrl } from '#lib/openrouter.ts';
import {
	DEFAULT_CONTEXT_SIZE,
	getSettings,
	updateSettings,
	type InferenceBackendConfig
} from '#lib/stores/settings.ts';
import { setContextSize as setIndicatorContextSize } from '#lib/stores/context.svelte.ts';
import { showToast } from '#lib/stores/toasts.svelte.ts';
import { getRunningCount } from '#lib/agent/inferenceQueue.svelte.ts';
import { splitServerArgs } from '#lib/inference/serverArgs.ts';
import { formatContextSize } from '#lib/utils/format.ts';
import { errMessage } from '#lib/utils/error.ts';

/**
 * Server status visible to the UI. The first four mirror the Rust-side
 * llama-server lifecycle (see Rust `ServerStatus` enum); `'remote'` is
 * a frontend-only synthetic state meaning "we're not running a local
 * sidecar right now — chat requests go to the configured remote URL".
 * It's set when the user flips the inference backend to remote mode
 * and cleared when they flip back (at which point the real local
 * lifecycle resumes from `'stopped'` → `'starting'` → `'ready'`).
 *
 * `'remote'` is strictly a UI badge concern: no request-path or agent
 * code may branch on server status or backend mode strings — that all
 * goes through `resolveBackendDescriptor` in `#lib/inference/descriptor`.
 */
export type ServerStatusType = 'stopped' | 'starting' | 'ready' | 'error' | 'remote';

/** What the startup check found wrong with the remote model. */
export type RemoteProblem =
	{ kind: 'missing'; modelId: string } | { kind: 'unreachable'; error: string };

// ts-rs-generated mirror of the Rust `SidecarStatus` enum
// (#[serde(tag = "type", content = "message")]).
type RustServerStatus = SidecarStatus;

export interface ServerState {
	status: ServerStatusType;
	errorMessage?: string;
	port: number;
	/**
	 * Display label shown next to the status indicator. For local mode
	 * this is the default port; for remote mode it's set to the short
	 * form of the configured base URL so the user can tell at a glance
	 * where their chat requests are going.
	 */
	remoteLabel?: string;
	/**
	 * Set when the startup check found the remote model gone or its server
	 * silent (see `#lib/inference/remoteModelCheck`). The badge shows it as
	 * an error that leads to Settings → Inference. Cleared on entering or
	 * leaving remote mode.
	 */
	remoteProblem?: RemoteProblem;
	/**
	 * What the local sidecar itself last reported. Equal to `status` in local
	 * mode; in remote mode `status` stays 'remote' and this keeps tracking the
	 * sidecar, so leaving remote mode shows whether it is actually running.
	 */
	localStatus?: ServerStatusType;
	/**
	 * The model this window last started the sidecar with. The badge names it,
	 * since Settings → Inference may have moved on since the start.
	 */
	localModelPath?: string;
	/**
	 * Set when llama-server failed to load on the GPU and was respawned
	 * with `--n-gpu-layers 0`. Drives the "Running on CPU" banner in the
	 * chat UI. Carries the first GPU-error stderr line (typically the
	 * VRAM allocation failure that preceded the abort) so the user has
	 * an actionable reason to look at, not just "performance is bad".
	 * Cleared the next time `startServer` is called.
	 */
	cpuFallback?: { reason: string };
	/**
	 * Set when a start attempt died on a context/KV allocation failure
	 * and the Rust supervisor is retrying with a smaller context. Holds
	 * the *latest* backoff of the current start (several rungs may be
	 * walked); the settings UI watches it to keep the selected context
	 * button in sync. Cleared the next time `startServer` is called.
	 */
	ctxBackoff?: ContextBackoffState;
}

// Svelte 5 runes-based state
let serverState = $state<ServerState>({
	status: 'stopped',
	errorMessage: undefined,
	port: PORTS.llama
});

function parseStatusEvent(payload: RustServerStatus): void {
	const status = payload.type.toLowerCase() as ServerStatusType;
	serverState.localStatus = status;
	// In remote mode the sidecar's events never move the badge: chat goes to
	// the remote server whether or not something started a local model. Only
	// `exitRemoteMode()` (or `syncBackendMode`) leaves remote mode.
	if (serverState.status === 'remote') return;
	serverState.status = status;
	serverState.errorMessage = payload.type === 'Error' ? payload.message : undefined;
}

/** Set the sidecar's status, and the shown one too unless remote mode holds it. */
function setLocalStatus(status: ServerStatusType, errorMessage?: string): void {
	serverState.localStatus = status;
	if (serverState.status === 'remote') return;
	serverState.status = status;
	serverState.errorMessage = errorMessage;
}

let listenerInitialized = false;

export async function initServerStore(): Promise<void> {
	if (listenerInitialized) return;
	listenerInitialized = true;

	// Sync initial state
	try {
		const status = await invoke<RustServerStatus>('get_server_status');
		parseStatusEvent(status);
	} catch {
		// Server command may not be available yet
	}

	// Sync CPU-fallback state. Important when the user reloads the
	// frontend (or the layout mounts late) after the Rust side already
	// flipped to fallback during startup — the live event would have
	// fired before this listener was attached, so we need to ask.
	try {
		const fallback = await invoke<{ reason: string } | null>('get_cpu_fallback_state');
		serverState.cpuFallback = fallback ?? undefined;
	} catch {
		// Command may not be available on older Rust builds
	}

	// Listen for status changes
	await listen<RustServerStatus>('server-status-changed', (event) => {
		parseStatusEvent(event.payload);
	});

	// Listen for CPU-fallback transitions emitted by the Rust side.
	// `gpu-fallback-active` fires once per failed-GPU-start, after the
	// CPU respawn has been launched; `gpu-fallback-cleared` fires on
	// every fresh `start_server` call (so a manual restart hides the
	// banner whether or not the new attempt ends up on GPU).
	await listen<{ reason: string }>('gpu-fallback-active', (event) => {
		serverState.cpuFallback = { reason: event.payload.reason };
	});
	await listen('gpu-fallback-cleared', () => {
		serverState.cpuFallback = undefined;
	});

	// The Rust supervisor detected a context/KV allocation failure during
	// startup and is already retrying with the next smaller ladder rung.
	// Surface what's happening and persist the smaller size so the settings
	// UI, the header context indicator, and the *next* start all agree with
	// what the server is actually running.
	// Multi-token prediction stopped the server from starting, and Rust has
	// already relaunched without it. Persist the preference off as well as
	// telling the user: the retry only covers this start, and leaving the
	// setting on would fail the same way on the next launch.
	await listen<string>('mtp-fallback-active', (event) => {
		updateSettings({ mtpEnabled: false });
		showToast(
			`Multi-token prediction failed to start (${event.payload}) — restarted without it and turned it off in Settings.`,
			{ kind: 'info' }
		);
	});

	await listen<ContextBackoffState>('context-backoff', (event) => {
		const { from, to } = event.payload;
		serverState.ctxBackoff = event.payload;
		if (getSettings().contextSize === from) {
			updateSettings({ contextSize: to });
		}
		setIndicatorContextSize(to);
		showToast(
			`Context size ${formatContextSize(from)} didn't fit in memory — retrying with ${formatContextSize(to)}. Your context size setting was updated.`,
			{ kind: 'info' }
		);
	});
}

export async function startServer(
	modelPath: string,
	ctxSize?: number,
	extraArgs?: string[]
): Promise<void> {
	const settings = getSettings();
	const args = extraArgs ?? splitServerArgs(settings.llamaServerExtraArgs);
	setLocalStatus('starting');
	serverState.localModelPath = modelPath;
	// Clear the CPU-fallback banner up front. Rust also emits
	// `gpu-fallback-cleared`, but doing it locally first means the
	// banner disappears the moment the user clicks "Restart on GPU"
	// instead of waiting for the IPC round-trip.
	serverState.cpuFallback = undefined;
	serverState.ctxBackoff = undefined;
	try {
		await invoke('start_server', {
			modelPath,
			ctxSize: ctxSize ?? DEFAULT_CONTEXT_SIZE,
			extraArgs: args.length > 0 ? args : null,
			// The preference only; Rust ANDs it with the model's own capability.
			mtp: settings.mtpEnabled,
			// Only reaches llama-server for models that actually have a
			// projector — Rust attaches it alongside `--mmproj`.
			mmprojOnCpu: settings.visionProjectorInSystemRam,
			// On: Rust omits --n-gpu-layers so llama.cpp's fit can place
			// layers and MoE experts in system RAM.
			ramOffload: settings.allowSpillToSystemRam,
			parallel: settings.localParallelSlots
		});
	} catch (e) {
		setLocalStatus('error', errMessage(e));
	}
}

export async function stopServer(): Promise<void> {
	try {
		await invoke('stop_server');
		setLocalStatus('stopped');
	} catch (e) {
		serverState.errorMessage = errMessage(e);
	}
}

// --- deferred restart (model switch / context-size change) -----------------

/**
 * A restart the user asked for — by switching model or changing the context
 * size — that we couldn't run immediately because inference was in flight.
 * Yanking the model out from under a running turn would abort it, so instead
 * we stash the target here and flush it the moment the process-wide inference
 * queue drains (see `maybeFlushPendingRestart`, driven by the root layout).
 *
 * The explicit Start / Stop / Restart buttons deliberately bypass all of
 * this — they act immediately and clear any pending restart.
 */
/** What the user changed to need a restart — drives the banner copy. */
export type RestartReason = 'model' | 'context' | 'projector' | 'memory' | 'parallel' | 'arguments';

export interface PendingRestart {
	modelPath: string;
	ctxSize: number;
	/** What the user changed — drives the banner copy. */
	reason: RestartReason;
}

let pendingRestart = $state<PendingRestart | null>(null);

export function getPendingRestart(): PendingRestart | null {
	return pendingRestart;
}

export function cancelPendingRestart(): void {
	pendingRestart = null;
}

/**
 * Apply a new model + context size by restarting the sidecar — but only if no
 * inference is running anywhere (chat / shell / job, across every window). If
 * a turn is in flight, defer: stash the target and return `false` so the
 * caller can surface a "restart queued" banner. Returns `true` when it
 * restarted right away.
 */
export async function restartServerWhenIdle(
	modelPath: string,
	ctxSize: number,
	reason: RestartReason
): Promise<boolean> {
	if (getRunningCount() > 0) {
		pendingRestart = { modelPath, ctxSize, reason };
		return false;
	}
	pendingRestart = null;
	await stopServer();
	await startServer(modelPath, ctxSize);
	return true;
}

// Re-entrancy guard: the layout effect can re-fire while a flush is mid-flight
// (startServer flips serverState), and we must not launch a second stop/start.
let flushing = false;

/**
 * If a restart is queued and inference has gone idle, run it now. Called
 * reactively from the root layout's effect; a no-op otherwise. Reads
 * `pendingRestart` and `getRunningCount()` synchronously so the calling
 * effect tracks both as dependencies.
 */
export async function maybeFlushPendingRestart(): Promise<void> {
	const pending = pendingRestart;
	if (!pending || flushing || getRunningCount() > 0) return;
	pendingRestart = null;
	flushing = true;
	try {
		await stopServer();
		await startServer(pending.modelPath, pending.ctxSize);
	} finally {
		flushing = false;
	}
}

/**
 * Transition the UI into remote-inference mode. Does NOT talk to the
 * Rust side — the actual `stop_server` invocation is the caller's
 * responsibility (it's done separately because the caller usually
 * wants to wait for stop to finish before flipping the status label).
 * Callers: the Settings page mode-toggle handler and the first-run
 * wizard's "Connect to remote" branch.
 *
 * The label combines the configured model id with a compact host:port
 * derived from `baseUrl`. We render both because the user's two natural
 * questions in remote mode are "which model am I talking to?" (the
 * model id, otherwise only visible inside Settings) and "where is it
 * hosted?" (the URL).
 */
export function enterRemoteMode(baseUrl: string, modelId: string): void {
	serverState.status = 'remote';
	serverState.errorMessage = undefined;
	serverState.remoteProblem = undefined;
	serverState.remoteLabel = buildRemoteLabel(baseUrl, modelId);
}

/**
 * Record what the remote model check found. Ignored unless the badge still
 * shows the server and model that were checked: the user may have changed
 * Settings → Inference while the check ran. Returns whether it was recorded.
 */
export function setRemoteProblem(
	baseUrl: string,
	modelId: string,
	problem: RemoteProblem | undefined
): boolean {
	if (serverState.status !== 'remote') return false;
	if (serverState.remoteLabel !== buildRemoteLabel(baseUrl, modelId)) return false;
	serverState.remoteProblem = problem;
	return true;
}

function buildRemoteLabel(baseUrl: string, modelId: string): string {
	// OpenRouter is a cloud backend — label it distinctly so the badge always
	// makes the "prompts leave your device" status obvious at a glance.
	if (isOpenRouterUrl(baseUrl)) {
		const model = modelId.trim();
		return model ? `${model} @ OpenRouter (cloud)` : 'OpenRouter (cloud)';
	}
	let host = baseUrl;
	try {
		const u = new URL(baseUrl);
		host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
	} catch {
		// Fall back to the raw string if it isn't a parseable URL.
	}
	const model = modelId.trim();
	if (!model) return host;
	if (!host) return model;
	return `${model} @ ${host}`;
}

/**
 * Leave remote-inference mode without starting anything. The status goes
 * back to what the sidecar last reported ('stopped' when it never did), so
 * the caller can then invoke startServer() for the local sidecar if needed.
 */
export function exitRemoteMode(): void {
	serverState.remoteLabel = undefined;
	serverState.remoteProblem = undefined;
	if (serverState.status === 'remote') {
		serverState.status = serverState.localStatus ?? 'stopped';
	}
}

/**
 * Make remote mode match Settings → Inference. The Settings page and the
 * setup wizard enter and leave it themselves, but settings can change
 * without them (the Remote control API's `settings.patch`, another window),
 * and the badge must not keep describing a backend chat no longer uses.
 * Starts and stops nothing. Remote with a blank URL counts as local, as it
 * does for request routing.
 */
export function syncBackendMode(
	backend: Pick<InferenceBackendConfig, 'mode' | 'remoteBaseUrl' | 'remoteModelId'>
): void {
	const remote = backend.mode === 'remote' && backend.remoteBaseUrl.trim().length > 0;
	if (!remote) {
		exitRemoteMode();
		return;
	}
	// Re-entering with the same label would drop a problem the startup check found.
	const label = buildRemoteLabel(backend.remoteBaseUrl, backend.remoteModelId);
	if (serverState.status === 'remote' && serverState.remoteLabel === label) return;
	enterRemoteMode(backend.remoteBaseUrl, backend.remoteModelId);
}

export async function getServerLogs(): Promise<string[]> {
	try {
		return await invoke<string[]>('get_server_logs');
	} catch {
		return [];
	}
}

export function getServerState(): ServerState {
	return serverState;
}
