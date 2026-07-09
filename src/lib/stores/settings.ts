// App settings — persisted to localStorage

import type { OpenRouterModel, OpenRouterKeyStatus } from '$lib/openrouter';

import type { EmailAccount } from '$lib/ipc/gen/EmailAccount';
import type { EmailProvider } from '$lib/ipc/gen/EmailProvider';
import type { ProxyConfig } from '$lib/ipc/gen/ProxyConfig';
import type { TlsMode } from '$lib/ipc/gen/TlsMode';
import type { ShellSelection } from '$lib/ipc/gen/ShellSelection';

export type ResponseFormat = 'minimal' | 'standard' | 'rich';
export type ThemeMode = 'system' | 'light' | 'dark';
export type SearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'searxng';

/**
 * A named API key in the shared key store. Keys are referenced by `id` from
 * inference backends and per-job model overrides, so updating a key here
 * propagates everywhere it's used. The `name` is a user-defined label
 * (e.g. "OpenRouter personal", "Work vLLM"); `value` is the actual token.
 */
export interface StoredApiKey {
	id: string;
	name: string;
	value: string;
}

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
	| 'openrouter'
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
	min_p?: number;
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
	/**
	 * Reference to a key in the Settings API-key store (by id). When set,
	 * `resolveChatEndpoint` resolves the actual key value from the store at
	 * request time, taking precedence over the legacy inline `remoteApiKey`.
	 */
	remoteApiKeyId: string | null;
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
	/**
	 * Cached OpenRouter model catalog (`GET /api/v1/models`). `null` means
	 * the catalog hasn't been fetched yet (or the user isn't on OpenRouter).
	 * The dedicated OpenRouter form populates and refreshes this; the generic
	 * remote form never touches it.
	 */
	openrouterCatalog: OpenRouterModel[] | null;
	/** Epoch ms of the last successful catalog fetch. `null` when never fetched. */
	openrouterCatalogAt: number | null;
	/** Cached OpenRouter key status (`GET /api/v1/key`). `null` when unchecked. */
	openrouterKeyStatus: OpenRouterKeyStatus | null;
	/** Epoch ms of the last key-status fetch. `null` when never checked. */
	openrouterKeyStatusAt: number | null;
	/**
	 * User-selected reasoning effort for the active OpenRouter model, or `null`
	 * when the model isn't reasoning-capable or no backend is OpenRouter. One of
	 * the model's `reasoning.supported_efforts` values; sent as
	 * `{ reasoning: { effort } }` in chat completions instead of the
	 * llama.cpp-specific `chat_template_kwargs`.
	 */
	openrouterReasoningEffort: string | null;
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
	 * Set once the user has seen (and dismissed) the notice that the
	 * recommended model lineup changed and their current model is now a
	 * legacy one. Keeps the Settings → Models banner from reappearing on
	 * every visit after they've acknowledged it.
	 */
	legacyModelNoticeDismissed: boolean;
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
	/** Named API keys shared across inference backends + per-job overrides. */
	apiKeys: StoredApiKey[];
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
	 * The shell picked from the toolbar on Windows (a PowerShell variant or a
	 * WSL distro). When set it takes priority over shellBinary; null means use
	 * the platform default / shellBinary. Only meaningful on Windows.
	 */
	shellSelection: ShellSelection | null;
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
	 * Whether newly opened Shell sessions start in Code mode. Off by
	 * default — new shells open as the read-only troubleshooting assistant,
	 * and the user flips Code mode on per-session from the sidebar header.
	 * When on, every new shell starts already in Code mode (editing +
	 * command execution enabled). Only affects shells opened after the
	 * change; existing sessions keep their current mode.
	 */
	shellCodeModeDefault: boolean;
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
	/**
	 * Max agent-loop iterations (model calls) for a Code-mode turn before it's
	 * forced to wrap up. Coding tasks chain many tool calls (grep → read → edit
	 * → test → fix), so this is higher than chat/shell. Raise it for big tasks;
	 * compaction keeps context bounded across iterations.
	 */
	codeMaxIterations: number;
}

/** Exported for the chat store's one-time legacy working-dir migration. */
export const SETTINGS_KEY = 'haruspex-settings';

const defaultInferenceBackend: InferenceBackendConfig = {
	mode: 'local',
	remoteBaseUrl: '',
	remoteServerUrls: [],
	remoteApiKey: '',
	remoteApiKeyId: null,
	remoteModelId: '',
	remoteContextSize: null,
	remoteVisionSupported: null,
	remoteBackendKind: null,
	remoteSampling: null,
	remoteReasoning: null,
	remoteParallel: null,
	allowParallelInference: false,
	openrouterCatalog: null,
	openrouterCatalogAt: null,
	openrouterKeyStatus: null,
	openrouterKeyStatusAt: null,
	openrouterReasoningEffort: null
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
	legacyModelNoticeDismissed: false,
	sandboxEnabled: false,
	sandboxApproval: 'once-per-chat',
	sandboxTimeoutSeconds: 60,
	thinkingEnabled: true,
	customSystemPrompt: '',
	inferenceBackend: defaultInferenceBackend,
	apiKeys: [],
	integrations: defaultIntegrations,
	proxy: defaultProxy,
	shellBinary: '',
	shellSelection: null,
	shellHistoryTurnsForPrompt: 3,
	shellMaxBytesPerCapture: 8192,
	shellSidebarWidth: 480,
	shellCodeModeDefault: false,
	codeAutoApprove: false,
	codeRunCommandTimeoutSecs: 30,
	codeCommandExec: 'auto',
	codeMaxIterations: 40
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
			// Migrate a legacy inline remoteApiKey into the key store. If
			// the user had a key saved before the key-store refactor and no
			// key ID yet, create a "Migrated" entry and wire it up so the
			// backend keeps working without re-entry.
			const parsedApiKeys: StoredApiKey[] = parsed.apiKeys ?? [];
			let apiKeys = parsedApiKeys;
			if (mergedInference.remoteApiKey && !mergedInference.remoteApiKeyId) {
				const migratedId = `key_migrated_${Date.now().toString(36)}`;
				apiKeys = [
					...parsedApiKeys,
					{ id: migratedId, name: 'Migrated', value: mergedInference.remoteApiKey }
				];
				mergedInference.remoteApiKeyId = migratedId;
			}
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
				apiKeys,
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

// --- API key store -------------------------------------------------------

let keyCounter = 0;

/** Generate a stable-enough id for a new key entry. */
function newKeyId(): string {
	keyCounter++;
	return `key_${Date.now().toString(36)}_${keyCounter.toString(36)}`;
}

/** All stored API keys. */
export function getApiKeys(): StoredApiKey[] {
	return settings.apiKeys;
}

/** Look up a key's value by id. Returns undefined when not found. */
export function getApiKeyValue(id: string | null | undefined): string | undefined {
	if (!id) return undefined;
	return settings.apiKeys.find((k) => k.id === id)?.value;
}

/** Add a new key and return its id. */
export function addApiKey(name: string, value: string): string {
	const id = newKeyId();
	settings = {
		...settings,
		apiKeys: [...settings.apiKeys, { id, name: name.trim() || 'Untitled', value }]
	};
	save(settings);
	return id;
}

/** Update an existing key's name and/or value. */
export function updateApiKey(
	id: string,
	patch: Partial<Pick<StoredApiKey, 'name' | 'value'>>
): void {
	settings = {
		...settings,
		apiKeys: settings.apiKeys.map((k) => (k.id === id ? { ...k, ...patch } : k))
	};
	save(settings);
}

/** Delete a key. Callers should clear any references to it first. */
export function deleteApiKey(id: string): void {
	settings = {
		...settings,
		apiKeys: settings.apiKeys.filter((k) => k.id !== id)
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
 * The remote backend config iff it's OpenRouter. Used to gate OpenRouter-
 * specific behavior: attribution headers, the `reasoning.effort` request
 * param (instead of llama.cpp `chat_template_kwargs`), and omitting the
 * llama.cpp-only `top_k` / `min_p` sampling params.
 */
function openrouterBackend(): InferenceBackendConfig | null {
	const inf = settings.inferenceBackend;
	return inf.mode === 'remote' && inf.remoteBackendKind === 'openrouter' ? inf : null;
}

/**
 * The currently-selected OpenRouter model from the cached catalog, or
 * `null` when the catalog isn't loaded / no model is picked. Used to read
 * per-model capability metadata (reasoning caps, vision, context) without
 * a second lookup at every call site.
 */
function openrouterSelectedModel(): OpenRouterModel | null {
	const inf = openrouterBackend();
	if (!inf?.openrouterCatalog) return null;
	return inf.openrouterCatalog.find((m) => m.id === inf.remoteModelId) ?? null;
}

/**
 * Whether the active model exposes a togglable reasoning / "thinking" mode.
 * Drives whether the Settings "Reasoning mode" toggle is shown. A toolchest
 * model reports it explicitly; an OpenRouter model reports it via its
 * `reasoning` caps from the cached catalog. Otherwise the only toggle we
 * know is Qwen's `enable_thinking` template kwarg — local models (managed
 * Qwen lineup) and recognized remote Qwen IDs support it; an unrecognized
 * remote model gets no kwarg (see getChatTemplateKwargs), so showing the
 * switch would be a no-op lie.
 */
export function isReasoningSupported(): boolean {
	const inf = toolchestBackend();
	if (inf?.remoteReasoning) {
		return inf.remoteReasoning.supported;
	}
	if (openrouterBackend()) {
		const m = openrouterSelectedModel();
		return !!m?.reasoning;
	}
	if (settings.inferenceBackend.mode === 'remote') {
		return getActiveModelFamily() !== null;
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
	// OpenRouter reasoning is driven by the `reasoning.effort` request param
	// (see getOpenRouterReasoningParam), not llama.cpp chat_template_kwargs.
	// Sending `enable_thinking` to a Claude/o-series model is misleading, so
	// return nothing here and let api.ts add the reasoning object instead.
	if (openrouterBackend()) {
		return {};
	}
	const inf = toolchestBackend();
	const reasoning = inf?.remoteReasoning;
	if (reasoning) {
		if (!reasoning.supported || reasoning.toggle !== 'chat_template_kwargs' || !reasoning.kwarg) {
			return {};
		}
		return { [reasoning.kwarg]: thinking };
	}
	// `enable_thinking` is a Qwen chat-template kwarg. Local models all come
	// from the managed Qwen lineup and recognized remote Qwen IDs want it too,
	// but an unrecognized remote model shouldn't receive Qwen-isms — send
	// nothing and let its own template defaults apply (mirrors the sampling
	// fallback rule in builtinSamplingParams).
	if (settings.inferenceBackend.mode === 'remote' && getActiveModelFamily() === null) {
		return {};
	}
	return { enable_thinking: thinking };
}

/**
 * The OpenRouter reasoning effort for the active model, or `null`
 * when reasoning is off / unsupported / not an OpenRouter backend. Returns
 * the `{ effort }` value that `api.ts` injects as `body.reasoning = { effort }`
 * (the `reasoning` key is added by `buildRequestBody`).
 *
 * When the user has disabled reasoning (via the global `thinkingEnabled`
 * toggle or a per-turn override) and the model is NOT `mandatory` reasoning,
 * we send `{ effort: 'none' }` to turn it off. For mandatory models we always
 * send the configured effort (the model rejects `'none'`).
 */
export function getOpenRouterReasoningParam(
	thinkingOverride?: boolean | null
): { effort: string } | null {
	const inf = openrouterBackend();
	if (!inf) return null;
	const m = openrouterSelectedModel();
	if (!m?.reasoning) return null;
	const thinking = thinkingOverride ?? settings.thinkingEnabled;
	const effort = inf.openrouterReasoningEffort ?? m.reasoning.default_effort;
	if (!thinking && !m.reasoning.mandatory) {
		return { effort: 'none' };
	}
	return { effort };
}

/**
 * Sampling overrides for a completion request. Every field is optional:
 * `undefined` means "don't send this parameter", letting the serving
 * backend's own default win (buildRequestBody omits undefined fields).
 * Known model families get fully-populated card-recommended values;
 * unrecognized remote models get none.
 */
export interface SamplingParams {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	/**
	 * Unsloth/Qwen cards specify `min_p=0.0` (disabled) for every profile.
	 * We send it explicitly because llama.cpp defaults `min_p` to 0.05, which
	 * would otherwise silently override the recommendation.
	 */
	min_p?: number;
	presence_penalty?: number;
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
 * Recommended sampling parameters per model family. Values are taken
 * verbatim from each model's published Unsloth/Qwen card ("We recommend the
 * following set of sampling parameters"). Every card specifies `min_p=0.0`
 * and `repetition_penalty=1.0` (disabled); we encode `min_p` explicitly and
 * leave repetition_penalty unset (1.0 is the no-op default). Keep these in
 * sync if a model is upgraded.
 *
 * The two-axis layout (thinking × {general, coding}) mirrors how the cards
 * group their recommendations; the agent loop picks `coding` when the
 * previous tool result indicates a code-editing context (a `<diagnostics>`
 * block, or a tool call against a Python file). The cards publish no
 * non-thinking *coding* profile, so that slot mirrors non-thinking general.
 *
 * Across the lineup the profiles are identical except the Qwen 3.6 dense
 * 27B, whose card uses `presence_penalty=0.0` (not 1.5) for thinking/general
 * — hence the separate `qwen3.6-27b` family.
 */
// The published non-thinking profile is identical across the whole Qwen
// lineup — shared so the two families can't drift apart silently.
const QWEN_NONTHINKING: ModelSamplingProfiles['nonThinking'] = {
	general: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5 },
	coding: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5 }
};

const SAMPLING_PROFILES: Record<string, ModelSamplingProfiles> = {
	// Qwen 3.5 4B/9B and Qwen 3.6 35B-A3B (sparse) — identical published profiles.
	'qwen3.5': {
		thinking: {
			general: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5 },
			coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0 }
		},
		nonThinking: QWEN_NONTHINKING
	},
	// Qwen 3.6 dense 27B — thinking/general uses presence_penalty 0.0.
	'qwen3.6-27b': {
		thinking: {
			general: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0 },
			coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0 }
		},
		nonThinking: QWEN_NONTHINKING
	}
};

const DEFAULT_FAMILY = 'qwen3.5';

/**
 * Map a model identity (local GGUF filename or remote model ID) to a
 * sampling-profile family. Falls back to `DEFAULT_FAMILY` for unknown
 * IDs so a misconfigured remote endpoint still gets reasonable values.
 */
function modelFamilyFromId(id: string | null | undefined): string | null {
	if (!id) return null;
	const lower = id.toLowerCase();
	// The dense 27B is the one model whose published thinking/general
	// presence_penalty differs (0.0 vs 1.5); give it its own profile.
	if (lower.includes('qwen3.6-27b') || lower.includes('qwen-3.6-27b')) return 'qwen3.6-27b';
	// Everything else in the lineup (3.5 4B/9B, 3.6 35B-A3B) shares one profile.
	if (
		lower.includes('qwen3.5') ||
		lower.includes('qwen-3.5') ||
		lower.includes('qwen3.6') ||
		lower.includes('qwen-3.6')
	) {
		return 'qwen3.5';
	}
	return null;
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
 * Whether the user has dismissed the "recommended models changed" notice.
 * Shown in Settings → Models when their active model is a legacy one.
 */
export function getLegacyModelNoticeDismissed(): boolean {
	return settings.legacyModelNoticeDismissed;
}

export function setLegacyModelNoticeDismissed(dismissed: boolean): void {
	if (settings.legacyModelNoticeDismissed !== dismissed) {
		settings = { ...settings, legacyModelNoticeDismissed: dismissed };
		save(settings);
	}
}

/**
 * Identify the active model family — used by `getSamplingParams` to look
 * up the right profile. In remote mode the family comes from the
 * configured `remoteModelId`; in local mode it comes from the GGUF
 * filename most recently registered via `setActiveLocalModel`. Returns
 * null when the model isn't from a recognized lineup.
 */
export function getActiveModelFamily(): string | null {
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
	// Unknown family: local models all come from the managed (Qwen) lineup,
	// so an unrecognized filename still gets the default profile. A remote
	// model we don't recognize gets NO sampling overrides — undefined fields
	// are omitted from the request, so the serving backend's own defaults
	// win instead of Qwen's card values (presence_penalty 1.5 et al.).
	if (family === null && settings.inferenceBackend.mode === 'remote') {
		return {};
	}
	const profiles = SAMPLING_PROFILES[family ?? DEFAULT_FAMILY];
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
		min_p: merged.min_p ?? fallback.min_p,
		presence_penalty: merged.presence_penalty ?? fallback.presence_penalty
	};
}

export function getSamplingParams(opts: SamplingOptions = {}): SamplingParams {
	const inf = toolchestBackend();
	if (inf?.remoteSampling) {
		return toolchestSamplingParams(inf.remoteSampling, opts);
	}
	const base = builtinSamplingParams(opts);
	// OpenRouter speaks OpenAI's param set: it accepts `temperature` and
	// `top_p` but the docs don't guarantee `top_k` / `min_p` won't 400 on
	// stricter upstream providers. Omit both for OpenRouter entirely (safe;
	// the router supplies sensible defaults). `presence_penalty` is in the
	// OpenAI param set and is kept — but only for recognized families,
	// since `base` is already empty for unknown models.
	if (openrouterBackend()) {
		return {
			temperature: base.temperature,
			top_p: base.top_p,
			presence_penalty: base.presence_penalty
		};
	}
	return base;
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
