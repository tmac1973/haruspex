// App settings — persisted to localStorage

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

export interface InferenceBackendConfig {
	mode: InferenceMode;
	/** Normalized base URL of the remote server (no trailing slash, no /v1 suffix). */
	remoteBaseUrl: string;
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
 */
export type EmailProviderId = 'gmail' | 'fastmail' | 'icloud' | 'yahoo' | 'custom';
export type EmailTlsMode = 'implicit' | 'starttls';

/**
 * A single configured email account. Field names match the
 * camelCase-serialized `EmailAccount` struct on the Rust side, so
 * the entire object roundtrips through `invoke` without translation.
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
export interface EmailAccount {
	id: string;
	label: string;
	enabled: boolean;
	sendEnabled: boolean;
	provider: EmailProviderId;
	emailAddress: string;
	password: string;
	imapHost: string;
	imapPort: number;
	imapTls: EmailTlsMode;
	smtpHost: string;
	smtpPort: number;
	smtpTls: EmailTlsMode;
}

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
export type ProxyMode = 'none' | 'manual';

export interface ProxyConfig {
	mode: ProxyMode;
	url: string;
	bypass: string;
}

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
}

const SETTINGS_KEY = 'haruspex-settings';

const defaultInferenceBackend: InferenceBackendConfig = {
	mode: 'local',
	remoteBaseUrl: '',
	remoteApiKey: '',
	remoteModelId: '',
	remoteContextSize: null,
	remoteVisionSupported: null,
	remoteBackendKind: null,
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

const defaults: AppSettings = {
	responseFormat: 'standard',
	theme: 'system',
	ttsVoice: 'af_heart',
	searchProvider: 'auto',
	braveApiKey: '',
	searxngUrl: 'http://localhost:8080',
	contextSize: 32768,
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
	shellRunAutoSubmit: false
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
 * Returns chat_template_kwargs forwarded to the Qwen 3 Jinja template.
 * `enable_thinking` toggles the model's reasoning/<think> block — driven
 * by the `thinkingEnabled` user setting (default on). Off skips the
 * reasoning block to save tokens; on improves quality on code-heavy
 * and multi-step tasks.
 */
export function getChatTemplateKwargs(): Record<string, unknown> {
	return { enable_thinking: settings.thinkingEnabled };
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
}

export function getSamplingParams(opts: SamplingOptions = {}): SamplingParams {
	const family = getActiveModelFamily();
	const profiles = SAMPLING_PROFILES[family] ?? SAMPLING_PROFILES[DEFAULT_FAMILY];
	const mode = settings.thinkingEnabled ? profiles.thinking : profiles.nonThinking;
	return opts.codeContext ? mode.coding : mode.general;
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
