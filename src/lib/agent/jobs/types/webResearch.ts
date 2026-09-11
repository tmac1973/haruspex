/**
 * Web research for the interactive job stages: guided planning's interview
 * and write turns, and autonomous coding's preflight. Each job type switches
 * it with its own `web_research` config key, on by default.
 *
 * Without it a planner is bounded by its training cutoff — it pins a package
 * version that has since moved, or plans against an API deprecated after it
 * was trained. With it, the risk is a research rathole: a local model handed
 * a search tool and no brief will browse. So the tools never ship without the
 * rules below, which make fact-checking the default and a wide survey
 * something only the user can ask for.
 *
 * The coding loop is not covered: it has always had these tools, for docs.
 */

/**
 * The read-only web tools a research-enabled stage adds to its allowlist.
 * research_url rather than fetch_url: it returns findings for a focus, not
 * the whole page, which matters on a local model's context budget.
 */
export const WEB_RESEARCH_TOOLS = ['web_search', 'research_url'];

/** `tools`, plus the web tools when research is on. Never mutates `tools`. */
export function withWebResearch(tools: readonly string[], enabled: boolean): string[] {
	return enabled ? [...tools, ...WEB_RESEARCH_TOOLS] : [...tools];
}

/**
 * Rules for a stage that can still ask the user questions. `askedIn` names
 * where a request for research would reach this stage — the seed
 * description, the plan, a revision request.
 */
export function interviewResearchRules(askedIn: string): string[] {
	return [
		'',
		'WEB RESEARCH (web_search, research_url):',
		'Your training has a cutoff; the web does not. Use it in exactly two ways:',
		'- CHECK, without being asked: before you rely on a fact that goes stale —',
		'  the current version of a package or tool, whether a library or API still',
		'  exists or is deprecated, current install or CLI syntax — confirm it. One',
		'  or two searches per fact, then move on. Do not browse for ideas,',
		'  background reading, or options nobody asked about.',
		`- SURVEY, only when asked: if ${askedIn} asks you to research`,
		'  something ("research the PDF libraries and give me a choice"), do that',
		'  properly, here: find the real candidates, then offer them as the options',
		'  of ONE `ask_user_question`, each with its trade-off in the description.',
		'  Present the choice; do not make it for the user.',
		'Give research_url a specific `focus`. Put what you learned that the plan',
		'relies on — versions, APIs, the chosen library and why — in the file you',
		'write: later stages read the files, never this conversation.'
	];
}

/** Rules for a stage whose decisions are all made: write and revise turns. */
export function writeResearchRules(): string[] {
	return [
		'',
		'WEB RESEARCH (web_search, research_url):',
		'Every decision is already made — do not research alternatives to one.',
		'Use the web only to CHECK a fact you are about to write that goes stale:',
		'the current version of a package, whether an API still exists, current',
		'install or CLI syntax. One or two searches per fact. If the message you',
		'were given explicitly asks you to research something, do that and apply',
		'what you find. Give research_url a specific `focus`.'
	];
}
