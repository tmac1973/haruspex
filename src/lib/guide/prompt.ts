/**
 * The system-prompt line for turns offered `haruspex_docs`: Chat, both Shell
 * modes and remote guests. Its own module so the prompt builders don't load
 * the guide's pages, or register tools, to get one sentence.
 */
/** Where the same guide is published (site/, built by scripts/build-guide.mjs). */
export const GUIDE_URL = 'https://haruspex.spronglehump.com/guide/';

export const GUIDE_PROMPT =
	"For questions about Haruspex itself (its features, its settings, or how it is set up here), call haruspex_docs before answering, and say so when the guide doesn't cover something.";
