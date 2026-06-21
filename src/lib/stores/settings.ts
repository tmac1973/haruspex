// App settings — persisted to localStorage

import type { EmailAccount } from '$lib/ipc/gen/EmailAccount';
import type { EmailProvider } from '$lib/ipc/gen/EmailProvider';
import type { ProxyConfig } from '$lib/ipc/gen/ProxyConfig';
import type { TlsMode } from '$lib/ipc/gen/TlsMode';

export type ResponseFormat = 'minimal' | 'standard' | 'rich';
export type ThemeMode = 'system' | 'light' | 'dark';
export type SearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'searxng';

/**
 * Which inference backend Haruspex is using.
 *
 * - `local`: the default — Haruspex spawns its own llama-server sidecar
 *   on port 8765 and manages model lifecycle itself. All existing users
 *   upgrade to this mode automatically.
 * - `remote`: the user has configured an external OpenAI-compatible
 *   server (llama-toolchest, LM Studio, Lemonade, Ollama, vLLM, TGI,
 *   their own llama.cpp deployment, etc.). The local sidecar does not
 *   spawn; chat completions route to `remoteBaseUrl`.
 */
export type InferenceMode = 'local' | 'remote';

/**
 * Which backend shape the probe detected. Drives UI labels and lets us
 * surface backend-specific affordances (e.g. llama-toolchest model
 * activation). `null` means the probe hasn't run yet or it failed.
 */
export type InferenceBackendKind =
	| 'llama-toolchest'
	| 'llama-server'
	| 'openai-compat'
	| 'ollama'
	| null;

/**
 * Recommended sampling parameters discovered from a remote backend. Every
 * field is optional — only what the model card / server actually specifies
 * is filled in; the client falls back to its built-in defaults for the
 * rest. Mirrors the Rust `SamplingParams` probe struct.
 */
export interface RemoteSamplingParams {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	presence_penalty?: number;
}

/** A named sampling preset (e.g. "thinking", "non-thinking", "thinking-coding"). */
export interface RemoteSamplingPreset extends RemoteSamplingParams {
	name: string;
	label?: string;
}

/** A model's recommended sampling: a resolved default plus named presets. */
export interface RemoteSamplingCaps {
	default: RemoteSamplingParams;
	presets: RemoteSamplingPreset[];
	/** Where the recommendation came from, e.g. "readme" or "generation_config.json". */
	source?: string | null;
}

/**
 * How a remote model exposes its reasoning / "thinking" mode. `toggle`
 * names the mechanism (`chat_template_kwargs` for Qwen-style
 * `enable_thinking`, `reasoning_effort`, or `none`); `kwarg` is the exact
 * key when the mechanism is chat_template_kwargs.
 */
export interface RemoteReasoningCaps {
	supported: boolean;
	default_enabled: boolean;
	toggle: string;
	kwarg?: string | null;
}

export interface InferenceBackendConfig {
	mode: InferenceMode;
	/** Normalized base URL of the remote server (no trailing slash, no /v1 suffix). */
	remoteBaseUrl: string;
	/**
	 * Saved remote server URLs the user can switch between via the Server
	 * URL dropdown. The currently active one is mirrored in `remoteBaseUrl`;
	 * this list is just the menu of choices the user has added. Empty on a
	 * fresh install — the form seeds it from `remoteBaseUrl` for upgrading
	 * users who already had a single server configured.
	 */
	remoteServerUrls: string[];
	/** Optional Bearer token for servers that require auth. Blank for self-hosted. */
	remoteApiKey: string;
	/** Model ID to include in chat completion requests when in remote mode. */
	remoteModelId: string;
	/** Remote-mode context size — detected from the probe or set manually. Falls back to `contextSize` when null. */
	remoteContextSize: number | null;
	/** Remote-mode vision capability — detected from the probe or overridden manually. */
	remoteVisionSupported: boolean | null;
	/** Backend kind recorded from the last successful probe. */
	remoteBackendKind: InferenceBackendKind;
	/**
	 * Recommended sampling discovered for the selected remote model. Only
	 * llama-toolchest reports this; `null` for every other backend (and
	 * before the first probe), in which case the built-in `SAMPLING_PROFILES`
	 * apply. Gated on `remoteBackendKind === 'llama-toolchest'` at read time.
	 */
	remoteSampling: RemoteSamplingCaps | null;
	/**
	 * Reasoning-mode capability discovered for the selected remote model.
	 * Only llama-toolchest reports this; `null` otherwise, in which case the
	 * client assumes Qwen-style `enable_thinking`.
	 */
	remoteReasoning: RemoteReasoningCaps | null;
	/**
	 * Parallel sequence-slot count the toolchest server runs the selected
	 * model with. Stored only for display in the "Detected capabilities"
	 * readout; the behavioral effect is folded into `allowParallelInference`
	 * at probe time. `null` for non-toolchest backends.
	 */
	remoteParallel: number | null;
	/**
	 * Remote-mode opt-in: skip the app's inference queue and let chat +
	 * job turns run in parallel against the remote server. Only safe when
	 * the server actually serves concurrent requests (vLLM, llama-server
	 * launched with `-np N`, hosted APIs). For single-slot servers
	 * leaving this off avoids HTTP-level head-of-line blocking with no
	 * "queued" indicator. Local mode always serializes regardless.
	 */
	allowParallelInference: boolean;
}

/**
 * Email provider presets we ship built-in. "custom" is the escape
 * hatch — the user types their own IMAP/SMTP hostnames.
 *
 * Aliases of the ts-rs-generated `EmailProvider` / `TlsMode` enums so
 * the Rust side stays the single source of truth for the wire shape.
 */
export type EmailProviderId = EmailProvider;
export type EmailTlsMode = TlsMode;

/**
 * A single configured email account — the ts-rs-generated mirror of the
 * Rust `EmailAccount` struct (camelCase-serialized), re-exported so the
 * entire object roundtrips through `invoke` without translation.
 *
 * Credentials (password) are stored in the settings blob alongside
 * the existing Brave / inference API keys — same trust level, same
 * lifecycle. Keyring integration is deferred to a later cross-cutting
 * change.
 *
 * `sendEnabled` is present from day 1 so Phase 10.2 sending can be
 * opted into per-account without a settings migration. In Phase 10.1
 * it has no effect.
 */
export type { EmailAccount };

export interface EmailIntegrationConfig {
	accounts: EmailAccount[];
}

export interface IntegrationsConfig {
	email: EmailIntegrationConfig;
}

/**
 * Network proxy for outbound web traffic (search, URL fetch, image search).
 * `mode: 'none'` bypasses the proxy entirely; `mode: 'manual'` routes every
 * egress request through `url` unless the target matches an entry in
 * `bypass`. The bypass list is free-form text — one entry per line or
 * comma-separated — where each entry is one of:
 *   - a hostname (e.g. `example.com`) which matches the host and any subdomain
 *   - an IP literal (e.g. `192.168.1.5`) — exact match
 *   - a CIDR block (e.g. `10.0.0.0/8`, `2001:db8::/32`) — subnet match
 *
 * Stored alongside other settings in localStorage; the Rust backend
 * re-parses `bypass` per request (no hot path).
 */
export type ProxyMode = ProxyConfig['mode'];

export type { ProxyConfig };

export interface AppSettings {
	responseFormat: ResponseFormat;
	theme: ThemeMode;
	ttsVoice: string;
	searchProvider: SearchProvider;
	braveApiKey: string;
	searxngUrl: string;
	contextSize: number;
	ttsReadTablesByColumn: boolean;
	searchRecency: 'any' | 'day' | 'week' | 'month' | 'year';
	audioOutputDevice: string;
	audioInputDevice: string;
	dismissedStartupNotice: boolean;
	keepRecentToolResults: boolean;
	/**
	 * Filename (basename, e.g. "Qwen3.5-9B-Q4_K_M.gguf") of the model the
	 * user most recently activated in Settings → Models. Persisted so the
	 * choice survives app restarts and re-entering the Settings page;
	 * `''` means "no preference recorded yet" — callers fall back to
	 * whatever `find_any_model` returns from disk.
	 */
	activeLocalModelFilename: string;
	/**
	 * Master switch for the Python code sandbox. When false, run_python
	 * / install_package / reset_python are filtered out of the model's
	 * tool list entirely, the same way fs tools are when no working
	 * directory is set.
	 */
	sandboxEnabled: boolean;
	/**
	 * Controls when the user is prompted before the Python sandbox runs
	 * model-authored code. 'off' runs every code call without asking
	 * (only meaningful for users who fully trust the model on this
	 * machine); 'once-per-chat' prompts on the first run_python in a
	 * chat and remembers the answer for that chat; 'every-run' prompts
	 * every single time.
	 */
	sandboxApproval: 'off' | 'once-per-chat' | 'every-run';
	/**
	 * Wall-clock timeout for a single sandbox tool call (run_python /
	 * install_package). Capped 5-300 seconds in the UI; the manager
	 * enforces interrupt-then-terminate escalation when crossOriginIsolated
	 * is true (otherwise just terminate).
	 */
	sandboxTimeoutSeconds: number;
	/**
	 * Whether to enable Qwen 3's reasoning/thinking mode. When on, the
	 * model emits a <think> block before its answer, which helps with
	 * code-heavy tasks (planning Python sandbox calls, debugging
	 * tracebacks) at the cost of more tokens per turn. Defaults to on
	 * because the reasoning quality improvement is large for the kinds
	 * of tasks Haruspex is used for; users can flip it off in Settings
	 * to save context on lighter chat workloads.
	 */
	thinkingEnabled: boolean;
	/**
	 * Extra instructions appended to the built-in system prompt. Empty
	 * string means "no addition". Free-form text edited in Settings; we
	 * append it verbatim under a CUSTOM INSTRUCTIONS heading so it sits
	 * after the built-in rules but before the response-format directive.
	 */
	customSystemPrompt: string;
	inferenceBackend: InferenceBackendConfig;
	integrations: IntegrationsConfig;
	proxy: ProxyConfig;
	/**
	 * Optional path to the shell binary the Shell tab launches. Empty
	 * string means "auto-detect from $SHELL with /bin/bash fallback"
	 * (the Rust side's default). Lets power users pin nu, fish, or a
	 * non-default install path.
	 */
	shellBinary: string;
	/**
	 * How many of the most-recent completed shell commands (and their
	 * output) to attach automatically to every chat message sent from
	 * the Shell-tab sidebar. 0 disables auto-attach. Default 3.
	 */
	shellHistoryTurnsForPrompt: number;
	/**
	 * Maximum size in bytes for the *output* of any single captured
	 * shell command attached to a chat message. When a command's output
	 * exceeds this, the middle is dropped — the head + tail of the
	 * output stay, with a "[middle truncated — N bytes total]" marker.
	 * Prevents one big dmesg / journalctl / log dump from blowing the
	 * model's context. 0 disables truncation. Default 8192 (8 KiB).
	 */
	shellMaxBytesPerCapture: number;
	/**
	 * Width in pixels of the Shell-tab assistant sidebar. Persisted so
	 * dragging the resize handle survives restarts. Clamped 320..most
	 * of the viewport at apply time.
	 */
	shellSidebarWidth: number;
	/**
	 * Whether the Shell-tab agent may write files anywhere on the
	 * filesystem (fs_write_text, fs_edit_text). Disabled by default;
	 * when off, the model only has read tools + can suggest shell
	 * commands. When on, the model can also call fs_write_text /
	 * fs_edit_text on absolute paths — including system config files
	 * if the app process has permission. Reads are always allowed in
	 * Shell mode regardless of this flag.
	 */
	shellAllowWrite: boolean;
	/**
	 * Whether clicking "Run" on an assistant-suggested command in the
	 * Shell tab automatically sends the command's output back to the
	 * assistant for analysis once it finishes. Off by default. When off,
	 * Run just executes the command in the terminal and stops there —
	 * the user decides whether to ask the assistant about the result.
	 */
	shellRunAutoSubmit: boolean;
	/**
	 * Code tab: when true, `run_command` runs risk-flagged commands without
	 * prompting. Off by default — the user opts into a "trust the model on
	 * this machine" posture explicitly.
	 */
	codeAutoApprove: boolean;
	/**
	 * Code mode: default wall-clock timeout (seconds) for a single
	 * `run_command` call. The model can override per call; this is the
	 * fallback. Clamped 5–1800 in the UI.
	 */
	codeRunCommandTimeoutSecs: number;
	/**
	 * How the Code-mode `run_command` tool executes when driven from a Shell
	 * session: `'auto'` drives the interactive PTY when shell integration is
	 * available and falls back to a one-shot capture otherwise; `'pty'` forces
	 * the terminal path; `'oneshot'` forces a fresh `sh -c` capture.
	 */
	codeCommandExec: 'auto' | 'pty' | 'oneshot';
}

const SETTINGS_KEY = 'haruspex-settings';

const defaultInferenceBackend: InferenceBackendConfig = {
	mode: 'local',
	remoteBaseUrl: '',
	remoteServerUrls: [],
	remoteApiKey: '',
	remoteModelId: '',
	remoteContextSize: null,
	remoteVisionSupported: null,
	remoteBackendKind: null,
	remoteSampling: null,
	remoteReasoning: null,
	remoteParallel: null,
	allowParallelInference: false
};

const defaultIntegrations: IntegrationsConfig = {
	email: { accounts: [] }
};

const defaultProxy: ProxyConfig = {
	mode: 'none',
	url: '',
	bypass: ''
};

// Canonical user-facing defaults. These are the single source of truth for
// values that also have to satisfy a Tauri command on the Rust side: the TS
// caller always resolves to these before invoking, so the Rust command no
// longer carries its own divergent fallback literal (audit X4/X5).
export const DEFAULT_CONTEXT_SIZE = 32768;
export const DEFAULT_SEARXNG_URL = 'http://localhost:8080';
export const DEFAULT_TTS_VOICE = 'af_heart';

const defaults: AppSettings = {
	responseFormat: 'standard',
	theme: 'system',
	ttsVoice: DEFAULT_TTS_VOICE,
	searchProvider: 'auto',
	braveApiKey: '',
	searxngUrl: DEFAULT_SEARXNG_URL,
	contextSize: DEFAULT_CONTEXT_SIZE,
	ttsReadTablesByColumn: true,
	searchRecency: 'any' as const,
	audioOutputDevice: '',
	audioInputDevice: '',
	dismissedStartupNotice: false,
	keepRecentToolResults: true,
	activeLocalModelFilename: '',
	sandboxEnabled: false,
	sandboxApproval: 'once-per-chat',
	sandboxTimeoutSeconds: 60,
	thinkingEnabled: true,
	customSystemPrompt: '',
	inferenceBackend: defaultInferenceBackend,
	integrations: defaultIntegrations,
	proxy: defaultProxy,
	shellBinary: '',
	shellHistoryTurnsForPrompt: 3,
	shellMaxBytesPerCapture: 8192,
	shellSidebarWidth: 480,
	shellAllowWrite: false,
	shellRunAutoSubmit: false,
	codeAutoApprove: false,
	codeRunCommandTimeoutSecs: 120,
	codeCommandExec: 'auto'
};

function load(): AppSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			// Deep-merge the inference backend sub-object so upgrading
			// users don't lose their other settings when we add new
			// fields to InferenceBackendConfig.
			const mergedInference: InferenceBackendConfig = {
				...defaultInferenceBackend,
				...(parsed.inferenceBackend ?? {})
			};
			// Deep-merge integrations so upgrading users keep their
			// other settings when new integration types are added.
			const parsedIntegrations = (parsed.integrations ?? {}) as Partial<IntegrationsConfig>;
			const mergedIntegrations: IntegrationsConfig = {
				email: {
					accounts: parsedIntegrations.email?.accounts ?? []
				}
			};
			const mergedProxy: ProxyConfig = {
				...defaultProxy,
				...(parsed.proxy ?? {})
			};
			return {
				...defaults,
				...parsed,
				inferenceBackend: mergedInference,
				integrations: mergedIntegrations,
				proxy: mergedProxy
			};
		}
	} catch {
		// ignore
	}
	return { ...defaults };
}

function save(settings: AppSettings): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// ignore
	}
}

let settings = load();

export function getSettings(): AppSettings {
	return settings;
}

export function updateSettings(partial: Partial<AppSettings>): void {
	settings = { ...settings, ...partial };
	save(settings);
}

/**
 * Replace the full list of email accounts. The Settings UI edits a
 * working copy and calls this once on save.
 */
export function setEmailAccounts(accounts: EmailAccount[]): void {
	settings = {
		...settings,
		integrations: {
			...settings.integrations,
			email: { accounts }
		}
	};
	save(settings);
}

/**
 * Whether the email integration should be considered "active" for the
 * purposes of tool visibility. True iff there is at least one account
 * that the user has toggled `enabled`.
 */
export function hasEnabledEmailAccount(): boolean {
	return settings.integrations.email.accounts.some((a) => a.enabled);
}

/**
 * Merge a partial update into the inferenceBackend sub-object. Callers
 * shouldn't have to rebuild the full config just to flip one field.
 */
export function updateInferenceBackend(partial: Partial<InferenceBackendConfig>): void {
	const current = settings.inferenceBackend;
	settings = {
		...settings,
		inferenceBackend: { ...current, ...partial }
	};
	save(settings);
}

/**
 * Merge a partial update into the proxy sub-object.
 */
export function updateProxy(partial: Partial<ProxyConfig>): void {
	const current = settings.proxy;
	settings = {
		...settings,
		proxy: { ...current, ...partial }
	};
	save(settings);
}

/**
 * Returns the context size that should be used for compaction threshold
 * calculations and agent-loop trimming. In remote mode this prefers the
 * probe-detected (or manually entered) `remoteContextSize`; in local
 * mode it falls back to the existing `contextSize` field.
 *
 * Returning the right value here is load-bearing: if we use the local
 * `contextSize` (default 32k) against a remote server that has an 8k
 * context, compaction won't fire until well past the real ceiling and
 * the request will error with "context length exceeded". If we use
 * `remoteContextSize` when it's valid, compaction kicks in correctly.
 */
export function getActiveContextSize(): number {
	const inf = settings.inferenceBackend;
	if (
		inf.mode === 'remote' &&
		typeof inf.remoteContextSize === 'number' &&
		inf.remoteContextSize > 0
	) {
		return inf.remoteContextSize;
	}
	return settings.contextSize;
}

/**
 * Whether the active backend can accept image inputs. Local llama-server
 * always can (multimodal projector handling is automatic); a remote backend
 * is assumed capable unless the user explicitly marked it otherwise.
 */
export function isVisionSupported(): boolean {
	const backend = settings.inferenceBackend;
	return backend.mode === 'remote' ? backend.remoteVisionSupported !== false : true;
}

export function applyTheme(theme?: ThemeMode): void {
	const mode = theme ?? settings.theme;
	const root = document.documentElement;
	root.removeAttribute('data-theme');
	if (mode === 'light') {
		root.setAttribute('data-theme', 'light');
	} else if (mode === 'dark') {
		root.setAttribute('data-theme', 'dark');
	}
}

/**
 * The remote backend config iff it's an llama-toolchest server that
 * reported capabilities. Everything capability-driven (sampling, reasoning)
 * is gated through this so other backends — vanilla llama.cpp, Ollama,
 * vLLM, OpenAI-compat — keep the built-in behavior.
 */
function toolchestBackend(): InferenceBackendConfig | null {
	const inf = settings.inferenceBackend;
	return inf.mode === 'remote' && inf.remoteBackendKind === 'llama-toolchest' ? inf : null;
}

/**
 * Whether the active model exposes a reasoning / "thinking" mode. Drives
 * whether the Settings "Reasoning mode" toggle is shown. Local and
 * non-toolchest remote backends are assumed capable (existing behavior);
 * a toolchest model reports it explicitly.
 */
export function isReasoningSupported(): boolean {
	const inf = toolchestBackend();
	if (inf?.remoteReasoning) {
		return inf.remoteReasoning.supported;
	}
	return true;
}

/**
 * Returns chat_template_kwargs forwarded to the model's Jinja template.
 * `enable_thinking` toggles the reasoning/<think> block — driven by the
 * `thinkingEnabled` user setting (default on). Off skips the reasoning
 * block to save tokens; on improves quality on code-heavy and multi-step
 * tasks.
 *
 * For an llama-toolchest backend we honor the model's discovered reasoning
 * shape: send the server-reported kwarg name, or send nothing at all when
 * the model has no chat_template_kwargs toggle (a non-reasoning model, or
 * one that toggles via a different mechanism) so we don't push an
 * unsupported kwarg into its template.
 *
 * `thinkingOverride` lets a caller (e.g. the Code tab) force reasoning on/off
 * for one turn regardless of the global setting. `null`/`undefined` uses the
 * global `thinkingEnabled`.
 */
export function getChatTemplateKwargs(thinkingOverride?: boolean | null): Record<string, unknown> {
	const thinking = thinkingOverride ?? settings.thinkingEnabled;
	const inf = toolchestBackend();
	const reasoning = inf?.remoteReasoning;
	if (reasoning) {
		if (!reasoning.supported || reasoning.toggle !== 'chat_template_kwargs' || !reasoning.kwarg) {
			return {};
		}
		return { [reasoning.kwarg]: thinking };
	}
	return { enable_thinking: thinking };
}

export interface SamplingParams {
	temperature: number;
	top_p: number;
	top_k: number;
	presence_penalty: number;
}

interface SamplingProfile {
	general: SamplingParams;
	coding: SamplingParams;
}

interface ModelSamplingProfiles {
	thinking: SamplingProfile;
	nonThinking: SamplingProfile;
}

/**
 * Recommended sampling parameters per model family. Values come straight
 * from each model's published model card — keep them in sync if a model
 * is upgraded. Add a new family by adding another entry here; the model
 * family is derived from the active model identity at runtime by
 * `modelFamilyFromId`. Unknown families fall back to `DEFAULT_FAMILY`.
 *
 * The two-axis layout (thinking × {general, coding}) mirrors how the
 * Qwen 3.5 card itself groups its recommendations; the agent loop picks
 * `coding` when the previous tool result indicates the model is in a
 * code-editing context (a `<diagnostics>` block, or a tool call against
 * a Python file).
 */
const SAMPLING_PROFILES: Record<string, ModelSamplingProfiles> = {
	'qwen3.5': {
		thinking: {
			general: { temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 1.5 },
			coding: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.0 }
		},
		nonThinking: {
			general: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
			// Qwen 3.5's card doesn't publish a non-thinking coding profile;
			// mirror general so we still ship deterministic top_k and a sane
			// presence_penalty when the user has thinking off.
			coding: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 }
		}
	}
};

const DEFAULT_FAMILY = 'qwen3.5';

/**
 * Map a model identity (local GGUF filename or remote model ID) to a
 * sampling-profile family. Falls back to `DEFAULT_FAMILY` for unknown
 * IDs so a misconfigured remote endpoint still gets reasonable values.
 */
function modelFamilyFromId(id: string | null | undefined): string {
	if (!id) return DEFAULT_FAMILY;
	const lower = id.toLowerCase();
	if (lower.includes('qwen3.5') || lower.includes('qwen-3.5')) return 'qwen3.5';
	return DEFAULT_FAMILY;
}

/**
 * Last-known active local model filename (e.g. "Qwen3.5-9B-Q4_K_M.gguf").
 * Set by the layout when the local sidecar is started, so sampling
 * resolution stays synchronous. Null until a model is loaded. Hydrated
 * from persisted settings on module load so sampling-profile lookup
 * works on the first render of a chat without waiting for the layout's
 * IPC round-trip.
 */
let activeLocalModelFilename: string | null = settings.activeLocalModelFilename || null;

/**
 * Tell the settings layer which local GGUF is currently loaded. Called
 * from places that invoke `get_active_model_path` immediately before
 * starting the local sidecar, and from the Models settings card when
 * the user clicks Use. Safe to call with null to clear.
 *
 * Persists the basename to localStorage as `activeLocalModelFilename`
 * so the choice survives reloads — without this, the UI's "active"
 * badge and the layout's auto-start fall back to whatever
 * `find_any_model` returns from disk (effectively random), which is
 * what users hit before this persisted.
 */
export function setActiveLocalModel(filenameOrPath: string | null): void {
	if (!filenameOrPath) {
		activeLocalModelFilename = null;
		if (settings.activeLocalModelFilename !== '') {
			settings = { ...settings, activeLocalModelFilename: '' };
			save(settings);
		}
		return;
	}
	// Accept either a bare filename or a full path; strip the directory.
	const slash = Math.max(filenameOrPath.lastIndexOf('/'), filenameOrPath.lastIndexOf('\\'));
	const basename = slash >= 0 ? filenameOrPath.slice(slash + 1) : filenameOrPath;
	activeLocalModelFilename = basename;
	if (settings.activeLocalModelFilename !== basename) {
		settings = { ...settings, activeLocalModelFilename: basename };
		save(settings);
	}
}

/**
 * Persisted filename (basename) of the model the user last activated.
 * Empty string if no choice has been recorded yet — callers should
 * fall back to a disk scan in that case.
 */
export function getActiveLocalModelFilename(): string {
	return settings.activeLocalModelFilename;
}

/**
 * Identify the active model family — used by `getSamplingParams` to look
 * up the right profile. In remote mode the family comes from the
 * configured `remoteModelId`; in local mode it comes from the GGUF
 * filename most recently registered via `setActiveLocalModel`.
 */
export function getActiveModelFamily(): string {
	const inf = settings.inferenceBackend;
	if (inf.mode === 'remote') return modelFamilyFromId(inf.remoteModelId);
	return modelFamilyFromId(activeLocalModelFilename);
}

export interface SamplingOptions {
	/**
	 * True when the next completion is expected to involve writing or
	 * fixing code (e.g. the previous tool result contained a
	 * `<diagnostics>` block, or the model just ran Python). Selects the
	 * model family's coding profile when available.
	 */
	codeContext?: boolean;
	/**
	 * Force reasoning on/off for this resolution regardless of the global
	 * `thinkingEnabled` setting (the Code tab uses this for its per-tab
	 * reasoning toggle). `null`/`undefined` uses the global setting.
	 */
	thinkingEnabled?: boolean | null;
}

/** Resolve the effective thinking state for a sampling/template call. */
function resolveThinking(override?: boolean | null): boolean {
	return override ?? settings.thinkingEnabled;
}

/** Built-in family-based sampling — the fallback when the backend doesn't
 * report its own recommendations (local mode, or any non-toolchest remote). */
function builtinSamplingParams(opts: SamplingOptions): SamplingParams {
	const family = getActiveModelFamily();
	const profiles = SAMPLING_PROFILES[family] ?? SAMPLING_PROFILES[DEFAULT_FAMILY];
	const mode = resolveThinking(opts.thinkingEnabled) ? profiles.thinking : profiles.nonThinking;
	return opts.codeContext ? mode.coding : mode.general;
}

/**
 * Pick the discovered toolchest preset that matches the current thinking /
 * code context, layered over the model's resolved `default`. Returns the
 * effective params, falling back to the built-in profile for any field the
 * server left unspecified.
 *
 * Preset selection mirrors how the built-in profiles are keyed:
 *   - thinking + code  → "thinking-coding" (then "thinking")
 *   - thinking         → "thinking"
 *   - non-thinking     → "non-thinking"
 */
function toolchestSamplingParams(caps: RemoteSamplingCaps, opts: SamplingOptions): SamplingParams {
	const byName = (name: string) => caps.presets.find((p) => p.name === name);
	let preset: RemoteSamplingParams | undefined;
	if (resolveThinking(opts.thinkingEnabled)) {
		preset = (opts.codeContext ? byName('thinking-coding') : undefined) ?? byName('thinking');
	} else {
		preset = byName('non-thinking');
	}
	// Preset overrides the resolved default for whatever fields it carries.
	const merged: RemoteSamplingParams = { ...caps.default, ...(preset ?? {}) };
	const fallback = builtinSamplingParams(opts);
	return {
		temperature: merged.temperature ?? fallback.temperature,
		top_p: merged.top_p ?? fallback.top_p,
		top_k: merged.top_k ?? fallback.top_k,
		presence_penalty: merged.presence_penalty ?? fallback.presence_penalty
	};
}

export function getSamplingParams(opts: SamplingOptions = {}): SamplingParams {
	const inf = toolchestBackend();
	if (inf?.remoteSampling) {
		return toolchestSamplingParams(inf.remoteSampling, opts);
	}
	return builtinSamplingParams(opts);
}

export function getResponseFormatPrompt(): string {
	switch (settings.responseFormat) {
		case 'minimal':
			return 'Format your responses as plain text. Use short paragraphs. Do not use markdown formatting, tables, bullet points, or emojis.';
		case 'rich':
			return 'Format your responses using rich markdown. Use headings, bullet points, numbered lists, tables, bold, italic, and code blocks where appropriate. Use relevant emojis to make the response visually engaging and easy to scan.';
		case 'standard':
		default:
			return 'Format your responses using markdown where helpful (headings, bullet points, code blocks). Keep formatting clean and readable.';
	}
}
