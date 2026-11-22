/** Research by email's settings, as the editor and the pipeline read them. */
export interface EmailResearchConfig {
	/** The email account it reads and replies from (Settings → Integrations → Email id). */
	accountId: string;
	/** What a request's subject must contain. Matching ignores case. */
	phrase: string;
	/** Most requests researched a day; null is no limit. */
	dailyLimit: number | null;
	/**
	 * 'arrival': Rust watches the inbox and the job runs when a request comes
	 * in, with the schedule as the backup check. 'schedule': only the schedule.
	 */
	pickup: EmailPickup;
}

export type EmailPickup = 'arrival' | 'schedule';

export const DEFAULT_DAILY_LIMIT = 10;
export const MAX_DAILY_LIMIT = 100;
export const PHRASE_MIN = 3;
export const PHRASE_MAX = 60;

export function emailResearchDefaults(): EmailResearchConfig {
	return { accountId: '', phrase: '', dailyLimit: DEFAULT_DAILY_LIMIT, pickup: 'arrival' };
}

/**
 * The config stored on a job; anything missing or malformed takes its default,
 * except `pickup`: a job saved before it existed ran on its schedule only, and
 * still does.
 */
export function parseEmailResearchConfig(typeConfig: string | null): EmailResearchConfig {
	const out = emailResearchDefaults();
	if (!typeConfig) return out;
	out.pickup = 'schedule';
	try {
		const raw = JSON.parse(typeConfig) as Partial<EmailResearchConfig>;
		if (raw.pickup === 'arrival') out.pickup = 'arrival';
		if (typeof raw.accountId === 'string') out.accountId = raw.accountId;
		if (typeof raw.phrase === 'string') out.phrase = raw.phrase;
		if (raw.dailyLimit === null) out.dailyLimit = null;
		else if (typeof raw.dailyLimit === 'number' && raw.dailyLimit > 0) {
			out.dailyLimit = Math.floor(raw.dailyLimit);
		}
	} catch {
		// A config that doesn't parse runs on the defaults, and the editor shows them.
	}
	return out;
}

export function emailResearchConfigJson(c: EmailResearchConfig): string {
	return JSON.stringify({
		accountId: c.accountId,
		phrase: c.phrase.trim(),
		dailyLimit: c.dailyLimit,
		pickup: c.pickup
	});
}

/** What the checks need besides the config. */
export interface ConfigContext {
	/** The job being saved; absent for a new one. */
	jobId?: number;
	/** The job's working directory, as typed. */
	workingDir: string;
	/** The job, other than this one, that already uses an account. */
	accountTakenBy: (accountId: string, exceptJobId?: number) => number | null;
	/** Whether the account exists and has Allow sending on. */
	canSend: (accountId: string) => boolean;
}

/** The first problem with a config, or null when it is fine. */
export function emailResearchProblem(c: EmailResearchConfig, ctx: ConfigContext): string | null {
	if (!c.accountId) return 'Choose an email account.';
	if (!ctx.canSend(c.accountId)) {
		return 'Turn on Allow sending for this account in Settings → Integrations → Email.';
	}
	const phrase = c.phrase.trim();
	if (!phrase) return 'Type a trigger phrase.';
	if (/[\r\n]/.test(c.phrase)) return 'The trigger phrase must be one line.';
	if (phrase.length < PHRASE_MIN || phrase.length > PHRASE_MAX) {
		return `The trigger phrase must be ${PHRASE_MIN} to ${PHRASE_MAX} characters.`;
	}
	if (
		c.dailyLimit !== null &&
		!(Number.isInteger(c.dailyLimit) && c.dailyLimit >= 1 && c.dailyLimit <= MAX_DAILY_LIMIT)
	) {
		return `The daily limit must be 1 to ${MAX_DAILY_LIMIT}, or No limit.`;
	}
	if (ctx.workingDir.trim()) return 'A Research by email job has no working directory.';
	if (ctx.accountTakenBy(c.accountId, ctx.jobId) !== null) {
		return 'This account already has a Research by email job.';
	}
	return null;
}
