// App settings — persisted to localStorage for now (Phase 7 will move to Tauri app data)

export type ResponseFormat = 'minimal' | 'standard' | 'rich';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppSettings {
	responseFormat: ResponseFormat;
	theme: ThemeMode;
	ttsVoice: string;
}

const SETTINGS_KEY = 'haruspex-settings';

const defaults: AppSettings = {
	responseFormat: 'standard',
	theme: 'system',
	ttsVoice: 'af_heart'
};

function load(): AppSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (raw) {
			return { ...defaults, ...JSON.parse(raw) };
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

export function applyTheme(theme?: ThemeMode): void {
	const mode = theme ?? settings.theme;
	const root = document.documentElement;
	root.removeAttribute('data-theme');
	if (mode === 'light') {
		root.setAttribute('data-theme', 'light');
	} else if (mode === 'dark') {
		root.setAttribute('data-theme', 'dark');
	}
	// 'system' = no attribute, CSS media query handles it
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
