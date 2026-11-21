/**
 * Camera alerts' settings: the per-camera `AlertConfig` (Rust's
 * `camera::AlertConfig`) and the email settings in Settings → Cameras →
 * Alerts. Both are kept to their limits here, whatever the form or an old
 * settings blob hands over.
 */
import type { AlertConfig } from '#lib/ipc/gen/AlertConfig.ts';
import type { QuietHours } from '#lib/ipc/gen/QuietHours.ts';

/** Most watch rules a camera keeps. */
export const MAX_WATCH_RULES = 20;
/** Longest a watch rule may be, in characters. */
export const MAX_WATCH_RULE_CHARS = 300;
/** Most addresses alerts go to. */
export const MAX_ALERT_ADDRESSES = 5;
/** Most pictures one alert email carries; matches Rust's `alert_mail::MAX_ATTACHMENTS`. */
export const MAX_ATTACHMENTS_PER_EMAIL = 6;
/** The most people a camera may usually have in view. */
export const MAX_USUAL_PEOPLE = 20;

/** Alerts off, one person usually in view, no rules, learned quiet hours. Matches Rust's default. */
export const defaultAlertConfig: AlertConfig = {
	enabled: false,
	usualPeople: 1,
	watchRules: []
};

/** Where alert emails go: Settings → Cameras → Alerts. */
export interface CameraAlertsSettings {
	/** Whether alert and digest emails are sent at all. */
	enabled: boolean;
	/** The email account they go from; it must have Allow sending on. */
	accountId: string;
	/** Who they go to. */
	to: string[];
}

export const defaultCameraAlerts: CameraAlertsSettings = {
	enabled: false,
	accountId: '',
	to: []
};

/** 24 booleans, or null when `value` isn't that. */
function hours(value: unknown): boolean[] | null {
	return Array.isArray(value) && value.length === 24 && value.every((v) => typeof v === 'boolean')
		? [...value]
		: null;
}

function quietHours(value: unknown): QuietHours | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const q = value as Record<string, unknown>;
	const weekday = hours(q.weekday);
	const weekend = hours(q.weekend);
	return weekday && weekend ? { weekday, weekend } : undefined;
}

/** A camera's alert settings with every field present and within its limits. */
export function normalizeAlertConfig(value: unknown): AlertConfig {
	const a = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const people = typeof a.usualPeople === 'number' ? Math.round(a.usualPeople) : 1;
	const rules = Array.isArray(a.watchRules)
		? a.watchRules
				.filter((r): r is string => typeof r === 'string')
				.map((r) => r.trim().slice(0, MAX_WATCH_RULE_CHARS))
				.filter(Boolean)
				.slice(0, MAX_WATCH_RULES)
		: [];
	const out: AlertConfig = {
		enabled: a.enabled === true,
		usualPeople: Number.isFinite(people) ? Math.min(Math.max(people, 0), MAX_USUAL_PEOPLE) : 1,
		watchRules: rules
	};
	const q = quietHours(a.quietHours);
	if (q) out.quietHours = q;
	return out;
}

/** A plain `local@domain.tld` check: enough to catch a typo, not a validator. */
export function isEmailAddress(value: string): boolean {
	return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value);
}

/** The addresses in `value`, trimmed, valid, unique and at most five. */
export function cleanAlertAddresses(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of value) {
		if (typeof v !== 'string') continue;
		const a = v.trim();
		if (!isEmailAddress(a) || seen.has(a.toLowerCase())) continue;
		seen.add(a.toLowerCase());
		out.push(a);
		if (out.length === MAX_ALERT_ADDRESSES) break;
	}
	return out;
}

/** The alert email settings with every field present and its addresses cleaned. */
export function normalizeCameraAlerts(value: unknown): CameraAlertsSettings {
	const a = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	return {
		enabled: a.enabled === true,
		accountId: typeof a.accountId === 'string' ? a.accountId : '',
		to: cleanAlertAddresses(a.to)
	};
}
