/** The news digest's settings, as the editor and the pipeline read them. */
export interface NewsDigestConfig {
	/** RSS or Atom feed URLs. */
	feeds: string[];
	/** What the user wants to read about, in their words. */
	interests: string;
	/** How far back to look. */
	hours: number;
	/** At most this many headlines on the card. */
	max: number;
}

export const DEFAULT_HOURS = 24;
export const DEFAULT_MAX = 6;

export function newsDigestDefaults(): NewsDigestConfig {
	return { feeds: [], interests: '', hours: DEFAULT_HOURS, max: DEFAULT_MAX };
}

/** The config stored on a job; anything missing or malformed takes its default. */
export function parseNewsDigestConfig(typeConfig: string | null): NewsDigestConfig {
	const out = newsDigestDefaults();
	if (!typeConfig) return out;
	try {
		const raw = JSON.parse(typeConfig) as Partial<NewsDigestConfig>;
		if (Array.isArray(raw.feeds)) {
			out.feeds = raw.feeds.filter((f): f is string => typeof f === 'string');
		}
		if (typeof raw.interests === 'string') out.interests = raw.interests;
		if (typeof raw.hours === 'number' && raw.hours > 0) out.hours = raw.hours;
		if (typeof raw.max === 'number' && raw.max > 0) out.max = raw.max;
	} catch {
		// A config that doesn't parse runs on the defaults, and the editor shows them.
	}
	return out;
}

/** Whether a string is an http(s) URL a feed could be fetched from. */
export function isFeedUrl(url: string): boolean {
	try {
		const u = new URL(url.trim());
		return u.protocol === 'https:' || u.protocol === 'http:';
	} catch {
		return false;
	}
}
