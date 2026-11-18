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

import { getDebugLogs, setVerbosePayloads } from '#lib/debugLog.ts';
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
import { getOpenSessions, getOpenViews, setActiveSession } from '#lib/stores/code.svelte.ts';
import type { PeerConfig } from '#lib/ipc/gen/PeerConfig.ts';
import { applyPeers } from '#lib/peers/service.ts';
import { peerView } from '#lib/peers/store.svelte.ts';
import { startRemoteSession } from '#lib/peers/remoteCodeSession.svelte.ts';
import { openRemoteChat } from '#lib/peers/remoteChat.svelte.ts';
import { getActiveChatSource } from '#lib/stores/activeChatSource.svelte.ts';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import { mcpState, startMcpServer, statusLabel } from '#lib/stores/mcpServers.svelte.ts';
import {
	getSettings,
	setMcpServers,
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
	ownerApi: (port: number) => Promise<{ base: string; token: string; certificate: string }>;
	/**
	 * Who may connect without a token (Settings → Remote control → Who can
	 * connect). Choosing either of the last two listens on every network, as
	 * Settings does.
	 */
	ownerAccess: (
		mode: 'tokens' | 'trusted' | 'lan',
		hosts: string[]
	) => Promise<{ address: string | null; hostname: string | null }>;
	/** Add an MCP server that runs `program args` (stdio), with `tools` switched on, and start it. */
	addMcpServer: (id: string, program: string, args: string[], tools: string[]) => Promise<string>;
	/** A new device's one-time pairing code, for the web client's link. */
	pairCode: (name: string) => Promise<string>;
	updateSettings: (patch: Partial<AppSettings>) => void;
	probeRemote: (
		baseUrl: string,
		apiKey: string,
		modelId: string | null
	) => Promise<Partial<InferenceBackendConfig>>;
	/** Trust these computers and follow them, as Settings → Remote control → Other computers. */
	setPeers: (peers: PeerConfig[]) => Promise<void>;
	/** Start a session on another computer in `root` and open it here; its id here. */
	peerStartSession: (peerId: string, root: string) => Promise<string>;
	/** Send in another computer's session open here, as its input box does. */
	peerSend: (viewId: string, text: string) => Promise<void>;
	/** Another computer's session as this window shows it. */
	peerSession: (viewId: string) => {
		status: string;
		busy: boolean;
		messages: number;
		lastAssistant: string | null;
	} | null;
	/** Open a chat on another computer (`new` starts one) in the Chat view; its id there. */
	peerOpenChat: (peerId: string, chatId: string) => Promise<string>;
	/** Send in the chat the Chat view shows. */
	peerChatSend: (text: string) => Promise<boolean>;
	/** Rust's last word on a computer's connection, or null before one. */
	peerStatus: (peerId: string) => string | null;
	/** The chat the Chat view shows, if it's another computer's. */
	peerChat: () => { busy: boolean; messages: number; lastAssistant: string | null } | null;
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
		remoteEngine: result.engine ?? null,
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

/** The text of the last answer in `messages`, if any. */
function lastAnswer(messages: { role: string; content: unknown }[]): string | null {
	const m = [...messages].reverse().find((x) => x.role === 'assistant');
	return m ? String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : null;
}

function mustPeer(peerId: string) {
	const view = peerView(peerId);
	if (!view) throw new Error(`no computer ${peerId} in Settings`);
	return view;
}

export function installDriveHooks(): void {
	window.__haruspexDrive = {
		setPeers: async (peers) => {
			updateSettings({ peersEnabled: true, peers });
			await applyPeers();
		},
		peerStartSession: async (peerId, root) =>
			(await startRemoteSession(mustPeer(peerId), { root, worktree: false, wslDistro: null })).id,
		peerSend: async (viewId, text) => {
			const view = getOpenViews().find((v) => v.id === viewId);
			if (!view) throw new Error(`no open session ${viewId}`);
			await view.send(text);
		},
		peerSession: (viewId) => {
			const view = getOpenViews().find((v) => v.id === viewId);
			if (!view) return null;
			return {
				status: view.status,
				busy: view.busy,
				messages: view.messages.length,
				lastAssistant: lastAnswer(view.messages)
			};
		},
		peerOpenChat: async (peerId, chatId) => {
			const view = mustPeer(peerId);
			const id =
				chatId === 'new' ? (await view.client.op<{ id: string }>({ type: 'chat.new' })).id : chatId;
			await openRemoteChat(view, id);
			return id;
		},
		peerStatus: (peerId) => peerView(peerId)?.status?.connection ?? null,
		peerChatSend: (text) => getActiveChatSource().sendMessage(text),
		peerChat: () => {
			const source = getActiveChatSource();
			if (!source.peer || !source.conversation) return null;
			return {
				busy: source.isGenerating,
				messages: source.conversation.messages.length,
				lastAssistant: lastAnswer(source.conversation.messages)
			};
		},
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
			return {
				base: `https://127.0.0.1:${status.port}`,
				token,
				certificate: status.certificate ?? ''
			};
		},
		ownerAccess: async (mode, hosts) => {
			updateSettings({
				ownerApiAccess: mode,
				ownerApiTrustedHosts: hosts,
				// As Settings does: the last two turn it on, nothing turns it off.
				ownerApiBindAll: mode !== 'tokens' || getSettings().ownerApiBindAll
			});
			const status = await applyOwnerApi();
			return { address: status.address, hostname: status.hostname };
		},
		addMcpServer: async (id, program, args, tools) => {
			const config: McpServerConfig = {
				id,
				label: id,
				enabled: true,
				source: { kind: 'custom', program, args },
				secrets: {},
				toolEnabled: Object.fromEntries(tools.map((t) => [t, true])),
				proxyUse: 'never',
				setupComplete: true,
				addonProjects: []
			};
			setMcpServers([config]);
			await startMcpServer(config, null);
			const state = mcpState(id);
			return state.error ? `${statusLabel(state)}: ${state.error}` : statusLabel(state);
		},
		pairCode: async (name) => (await createOwnerClient(name, ALL_SCOPES)).pairCode,
		updateSettings,
		probeRemote
	};
	void listen<EngineEvent[]>('engine://event', ({ payload }) => logEvents(payload));
}
