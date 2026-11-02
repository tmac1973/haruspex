/** The email digest's settings, as the editor and the pipeline read them. */
export interface EmailDigestConfig {
	/** The email accounts to read (Settings → Integrations → Email ids). */
	accountIds: string[];
	/** What counts as important, in the user's words. */
	rule: string;
	/** How far back to look. */
	hours: number;
	/** At most this many messages on the card. */
	max: number;
}

export const DEFAULT_HOURS = 24;
export const DEFAULT_MAX = 8;

export function emailDigestDefaults(): EmailDigestConfig {
	return { accountIds: [], rule: '', hours: DEFAULT_HOURS, max: DEFAULT_MAX };
}

/** The config stored on a job; anything missing or malformed takes its default. */
export function parseEmailDigestConfig(typeConfig: string | null): EmailDigestConfig {
	const out = emailDigestDefaults();
	if (!typeConfig) return out;
	try {
		const raw = JSON.parse(typeConfig) as Partial<EmailDigestConfig>;
		if (Array.isArray(raw.accountIds)) {
			out.accountIds = raw.accountIds.filter((id): id is string => typeof id === 'string');
		}
		if (typeof raw.rule === 'string') out.rule = raw.rule;
		if (typeof raw.hours === 'number' && raw.hours > 0) out.hours = raw.hours;
		if (typeof raw.max === 'number' && raw.max > 0) out.max = raw.max;
	} catch {
		// A config that doesn't parse runs on the defaults, and the editor shows them.
	}
	return out;
}
