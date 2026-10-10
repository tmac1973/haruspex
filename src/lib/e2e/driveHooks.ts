/**
 * What `scripts/drive.mjs` reads from the real app through WebDriver: the
 * agent debug log, the Code tab's sessions, the pending command approval, and
 * the remote-server probe the Settings form runs. It also switches the active
 * session and settings; everything a user would press, the driver presses in
 * the UI instead — or, with `--via engine`, sends as an engine operation
 * (`#lib/engine/`), through Rust as phase 3's API will.
 *
 * Installed by `src/hooks.client.ts` only when the build was made with
 * `VITE_HARUSPEX_E2E=1`, which `e2e/app/build.mjs` sets. The check is a
 * build-time constant, so a normal build drops this module entirely.
 */
import { invoke } from '@tauri-apps/api/core';

import { listen } from '@tauri-apps/api/event';

import { getDebugLogs, setVerbosePayloads } from '#lib/debug-log.ts';
import { currentPrompts } from '#lib/engine/prompts.svelte.ts';
import { sessionState } from '#lib/engine/state.ts';
import { emptyMirror, reduce, type Mirror } from '#lib/engine/reduce.ts';
import {
	isSessionEvent,
	type EngineEvent,
	type EngineOp,
	type SessionState
} from '#lib/engine/types.ts';
import { applyOwnerApi, createOwnerClient, ALL_SCOPES } from '#lib/owner/service.ts';
import { pickProbedModel, probedModelCaps, type ProbeResult } from '#lib/inferenceProbe.ts';
import { getOpenSessions, setActiveSession } from '#lib/stores/code.svelte.ts';
import {
	updateSettings,
	type AppSettings,
	type InferenceBackendConfig
} from '#lib/stores/settings.ts';

export interface DriveHooks {
	debugLogs: () => string[];
	setVerbosePayloads: (on: boolean) => void;
	/** The sessions open in this (the main) window. */
	codeSessions: () => SessionState[];
	/** Show this session's pane, so its input box and Stop button exist. */
	activateSession: (id: string) => void;
	/**
	 * The command Run this command? is showing in this window, if any: one at
	 * a time, with `queued` more waiting behind it.
	 */
	pendingApproval: () => {
		promptId: string;
		sessionId: string | null;
		command: string;
		reasons: string[];
		requester: string | null;
		queued: number;
	} | null;
	/** Run an engine operation through Rust, in whichever window has the session. */
	engine: (op: EngineOp) => Promise<unknown>;
	/** Events from every window, as Rust mirrors them here; `next` is the next `since`. */
	engineEvents: (since: number) => { events: EngineEvent[]; next: number };
	/** The session as its logged events rebuild it, as a client elsewhere would. */
	engineMirror: (id: string) => Mirror;
	/**
	 * Turn Settings → Remote control on, on this computer only at `port`, and
	 * add a device with every permission: what `drive start --api` drives.
	 */
	ownerApi: (port: number) => Promise<{ base: string; token: string }>;
	/** Who may connect without a token (Settings → Remote control → Who can connect). */
	ownerAccess: (mode: 'tokens' | 'trusted' | 'lan', hosts: string[]) => Promise<unknown>;
	/** A new device's one-time pairing code, for the web client's link. */
	pairCode: (name: string) => Promise<string>;
	updateSettings: (patch: Partial<AppSettings>) => void;
	probeRemote: (
		baseUrl: string,
		apiKey: string,
		modelId: string | null
	) => Promise<Partial<InferenceBackendConfig>>;
}

declare global {
	interface Window {
		__haruspexDrive?: DriveHooks;
	}
}

/**
 * The remote settings Settings → Inference → Test connection would save for
 * this server: the same probe, model pick and capabilities.
 */
async function probeRemote(
	baseUrl: string,
	apiKey: string,
	modelId: string | null
): Promise<Partial<InferenceBackendConfig>> {
	const result = await invoke<ProbeResult>('probe_inference_server', {
		baseUrl,
		apiKey: apiKey || null
	});
	const model = pickProbedModel(result.models, modelId);
	if (!model) throw new Error(`${result.base_url} lists no models`);
	if (modelId && model.id !== modelId) {
		throw new Error(
			`${result.base_url} has no model ${modelId}; it has ${result.models.map((m) => m.id).join(', ')}`
		);
	}
	const caps = probedModelCaps(model);
	return {
		mode: 'remote',
		remoteBaseUrl: result.base_url,
		remoteServerUrls: [result.base_url],
		remoteApiKey: apiKey,
		remoteApiKeyId: null,
		remoteModelId: model.id,
		remoteContextSize: caps.contextSize ?? result.default_context_size ?? null,
		remoteVisionSupported: caps.vision,
		remoteBackendKind: result.kind,
		remoteSampling: model.sampling ?? null,
		remoteReasoning: model.reasoning ?? null,
		remoteParallel: model.parallel ?? null
	};
}

/** The last events the engine sent, from every window. */
const EVENT_LOG_MAX = 2000;
const eventLog: EngineEvent[] = [];
let eventsDropped = 0;

function logEvents(events: EngineEvent[]): void {
	eventLog.push(...events);
	const over = eventLog.length - EVENT_LOG_MAX;
	if (over > 0) {
		eventLog.splice(0, over);
		eventsDropped += over;
	}
}

export function installDriveHooks(): void {
	window.__haruspexDrive = {
		debugLogs: getDebugLogs,
		setVerbosePayloads,
		codeSessions: () => getOpenSessions().map(sessionState),
		activateSession: setActiveSession,
		pendingApproval: () => {
			const p = currentPrompts('main').find((x) => x.kind === 'command');
			if (!p) return null;
			const d = p.detail as { command: string; reasons: string[]; queued: number };
			return { promptId: p.promptId, sessionId: p.sessionId, requester: p.requester, ...d };
		},
		engine: (op) => invoke('engine_request', { op }),
		engineEvents: (since) => ({
			events: eventLog.slice(Math.max(0, since - eventsDropped)),
			next: eventsDropped + eventLog.length
		}),
		engineMirror: (id) =>
			eventLog
				.filter(isSessionEvent)
				.filter((e) => e.sessionId === id)
				.reduce(reduce, emptyMirror()),
		ownerApi: async (port) => {
			updateSettings({ ownerApiEnabled: true, ownerApiPort: port, ownerApiBindAll: false });
			const status = await applyOwnerApi();
			const { token } = await createOwnerClient('drive', ALL_SCOPES);
			return { base: `http://127.0.0.1:${status.port}`, token };
		},
		ownerAccess: async (mode, hosts) => {
			updateSettings({ ownerApiAccess: mode, ownerApiTrustedHosts: hosts });
			return applyOwnerApi();
		},
		pairCode: async (name) => (await createOwnerClient(name, ALL_SCOPES)).pairCode,
		updateSettings,
		probeRemote
	};
	void listen<EngineEvent[]>('engine://event', ({ payload }) => logEvents(payload));
}
