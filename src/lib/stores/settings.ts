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
	dismissedGpuWarning: boolean;
	defaultWorkingDir: string;
	inferenceBackend: InferenceBackendConfig;
}

const SETTINGS_KEY = 'haruspex-settings';

const defaultInferenceBackend: InferenceBackendConfig = {
	mode: 'local',
	remoteBaseUrl: '',
	remoteApiKey: '',
	remoteModelId: '',
	remoteContextSize: null,
	remoteVisionSupported: null,
	remoteBackendKind: null
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
	dismissedGpuWarning: false,
	defaultWorkingDir: '',
	inferenceBackend: defaultInferenceBackend
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
			return { ...defaults, ...parsed, inferenceBackend: mergedInference };
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
 * Returns chat_template_kwargs to disable thinking at the Jinja template
 * level. Qwen 3 supports enable_thinking as a template kwarg — with this
 * set to false, the model emits the /no_think control token and skips
 * reasoning blocks entirely. Thinking mode is always off because:
 *  - It causes tool call format breakage (Qwen emits non-standard XML)
 *  - It consumes tokens that should go to the answer
 *  - It offers no benefit for chat + web research
 */
export function getChatTemplateKwargs(): Record<string, unknown> {
	return { enable_thinking: false };
}

export interface SamplingParams {
	temperature: number;
	top_p: number;
}

export function getSamplingParams(): SamplingParams {
	return { temperature: 0.7, top_p: 0.8 };
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
