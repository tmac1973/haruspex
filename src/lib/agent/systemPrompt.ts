import { type ChatMessage, messageText } from '#lib/api.ts';
import {
	getIncludeImagesPrompt,
	getResponseFormatPrompt,
	getSettings,
	hasEnabledEmailAccount,
	hasSendableEmailAccount,
	hasEnabledCalendarAccount,
	hasEnabledContactsAccount
} from '#lib/stores/settings.ts';
import { formatTodayLong } from '#lib/utils/format.ts';
import { GUIDE_PROMPT } from '#lib/guide/prompt.ts';
import { feedbackPromptSection } from '#lib/harnessFeedback/prompt.ts';
import { registeredMcpServerLabels } from '#lib/agent/tools/mcp.ts';
import { typedText } from '#lib/skills/content.ts';
import { imageModelsPrompt } from '#lib/image/modelsPrompt.ts';

const REVIEW_PATTERNS =
	/\b(best|top\s+\d|recommend|review|comparison|compare|vs\.?|versus|worth|which\s+(?:one|should)|budget|premium|upgrade)\b/i;

function looksLikeReviewQuery(content: string): boolean {
	return REVIEW_PATTERNS.test(content);
}

const FILE_OUTPUT_PATTERNS =
	/\b(pdf|docx|xlsx|odt|ods|odp|pptx|spreadsheet|word\s+doc(?:ument)?|excel\s+(?:file|spreadsheet|sheet)|open\s*document|libreoffice|presentation|powerpoint|slide\s*deck)\b/i;

export function looksLikeFileOutputRequest(content: string): boolean {
	return FILE_OUTPUT_PATTERNS.test(content);
}

/**
 * Recalled memories for this turn, rendered into the prompt by the caller
 * that has them. A PARAMETER rather than something this module fetches: chat
 * is the only surface memory applies to, and job runs, remote guests and the
 * shell assistant all build their prompts through here too. Passing it in
 * means they cannot receive the user's memories by accident — the plan's
 * "chat only" scope is enforced by the shape of this signature.
 */
export interface SystemPromptOptions {
	memorySection?: string;
	/**
	 * The turn's skill list (`skillsPromptSection`). Passed in rather than
	 * looked up, for the same reason as `memorySection`: only Chat builds one,
	 * so jobs and remote guests can't get it by accident.
	 */
	skillsSection?: string;
	/**
	 * Whether to add the IMAGES block. A PARAMETER for the same reason
	 * `memorySection` is one: chat is the only surface images apply to, and
	 * job runs, remote guests and the shell assistant all build their prompts
	 * through here too. Passing it in means they cannot get it by accident —
	 * the "local Chat tab only" scope is enforced by the shape of this
	 * signature rather than by a check someone has to remember.
	 */
	includeImages?: boolean;
	/**
	 * List the image models the image tools choose from (`imageModelsPrompt`).
	 * Chat only, for the same reason: no other turn is offered those tools.
	 */
	imageModels?: boolean;
	/**
	 * Tell the model about `haruspex_docs`. Only for turns that are offered it:
	 * Chat and remote guests. A job builds its prompt here too, and gets
	 * neither the tool nor the line.
	 */
	guide?: boolean;
	/**
	 * Ask for `haruspex_feedback` reports, when Settings → Feedback has them on.
	 * The Chat tab only: a remote guest never has the tool, and a job is asked
	 * after its run instead.
	 */
	feedback?: boolean;
	/**
	 * A lean Chat turn (Settings → General → Lean mode): the prompt names only
	 * what `LEAN_CHAT_TOOLS` can do, so no email, integrations, sandbox,
	 * feedback or file writing, and the working folder is for reading.
	 */
	lean?: boolean;
}

/** The `haruspex_docs` line, for a turn offered the tool; empty otherwise. */
function guideSection(guide: boolean | undefined): string {
	return guide ? `\n\n${GUIDE_PROMPT}` : '';
}

export function buildSystemPrompt(
	workingDir: string | null,
	opts: SystemPromptOptions = {}
): ChatMessage {
	const today = formatTodayLong();
	const memorySection = opts.memorySection ?? '';
	const lean = opts.lean === true;
	// The guide and the skills describe the whole app; a lean turn has a few
	// of its tools, and a small model otherwise answers from the guide.
	const leanSection = lean
		? `

LEAN MODE:
- Lean mode is on (Settings → General → Lean mode). Your tools are the ones you were given: web search and pages, image search, reading files in the working folder, the Haruspex guide, memory and skills.
- The guide describes the full app. When asked what you can do, answer from the tools you have, not from the guide.
- If a request needs anything else (writing files, Python, pictures, music, speech, email, calendar, the Code or Shell tabs), say that it needs lean mode turned off. Never say you tried a tool you don't have.`
		: '';
	const imagesSection = opts.includeImages ? getIncludeImagesPrompt({ lean }) : '';
	const imageModelsSection = opts.imageModels && !lean ? imageModelsPrompt() : '';

	const fsSection = workingDir
		? `

FILESYSTEM ACCESS:
- Working directory: ${workingDir}
- Use fs_list_dir first to see what files exist before reading specific files.
- Only use filesystem tools when the user explicitly asks to work with files.
- ${
				lean
					? 'You can read files here but not create or change them. Put what the user asked for in your reply.'
					: 'When the user asks you to create a file (PDF, docx, xlsx, etc.), do your research and call fs_write_document, fs_write_spreadsheet or fs_write_slides with complete content IN THE SAME TURN. Do not dump the content as a chat message instead.'
			}`
		: '';

	const emailSection =
		!lean && hasEnabledEmailAccount()
			? `

EMAIL INTEGRATION:
- The user has connected email accounts. Only use email tools when explicitly asked about email.
- Use email_list_recent first, then email_summarize_message on the 3-5 most important messages. Skip newsletters and automated notifications unless asked.
- Use email_read_full only when the user needs verbatim text.${
					hasSendableEmailAccount()
						? '\n- To write or reply to mail, use email_compose. It opens a draft the user reviews and sends themselves; say it was sent only when the result says so.'
						: ''
				}`
			: '';

	// Named services beat a general instruction. "Prefer integrations" loses to
	// a concrete run_python the model already knows how to write; "GitHub is
	// connected" gives it something to reach for.
	// Email has its own section above with usage rules of its own, so it is
	// named here only to put it in the same "prefer these" list.
	const connected = [
		...(hasEnabledEmailAccount() ? ['Email'] : []),
		...(hasEnabledCalendarAccount() ? ['Calendar'] : []),
		...(hasEnabledContactsAccount() ? ['Contacts'] : []),
		...registeredMcpServerLabels()
	];
	const integrationsSection =
		!lean && connected.length > 0
			? `

CONNECTED INTEGRATIONS: ${connected.join(', ')}
- When a request is about one of these services, use its tools. They are already authenticated and return structured data.
- Do NOT write Python, call the service's API by hand, or fetch its web pages to get something one of these tools returns. That is slower, unauthenticated, and frequently wrong.`
			: '';

	const sandboxFsSection =
		workingDir && getSettings().sandboxEnabled
			? `
- Working dir files: the user's working directory is mirrored into the sandbox before each run, and your writes are flushed back after. Natural Python file I/O — pd.read_csv('orders.csv'), open('notes.txt').read(), plt.savefig('plot.png'), pd.to_csv('out.csv'), etc. — just works. Both relative paths (resolved against the working dir) and absolute paths into the working dir resolve to the right bytes. Files larger than ~50 MB are not mirrored automatically; for those use fs_read_* / fs_write_* instead.`
			: '';

	return {
		role: 'system',
		content: `You are Haruspex, a helpful, private AI assistant running on the user's computer.

Today's date is ${today}. Your training data has a cutoff, so your memory of the world may be incomplete, wrong, or out of date.${guideSection(opts.guide)}${feedbackPromptSection(opts.feedback === true && !lean)}${leanSection}

SEARCH RULES:
- Search before answering any question about the world — a person, place, animal, plant, organisation, product, event, or how something works. "Tell me about X" is one of these. Your recollection is not a source; a citation is.
- Do NOT search when there is nothing external to check: arithmetic, code you are writing, a concept you are explaining, creative writing, a picture to draw, or files the user gave you.
- Use the user's exact terms.
- Use fetch_url on 2-4 of the most relevant results before answering.
- Only cite sources you actually fetched. Do not cite URLs from search snippets alone.
- For reviews or "best of" questions, include Reddit alongside review sites.

INLINE CITATIONS:
- Every fetch_url / research_url result starts with a "[Source: <url>]" header identifying which URL the content came from. Some also carry an "[Image: <url>]" line — that is a picture from the page, available if an image would help.
- Cite facts from the web inline as [source](URL). The anchor text must be the literal word "source". Example: "...the device ships with 16 GB of RAM [source](https://example.com/product-page)."
- Each [source](URL) must point to the specific page where that claim appeared. Copy the URL from the "[Source: <url>]" header.
- Never invent a URL. Never cite a URL from an earlier turn.
- The UI converts your [source](URL) links into numbered references [1], [2], [3] automatically — do NOT append a Sources or References section at the end.
- Citations are mandatory for factual claims sourced from the web.${fsSection}${emailSection}${integrationsSection}${
			!lean && getSettings().sandboxEnabled
				? `

PYTHON SANDBOX:
- You have a Python sandbox in this app. Use run_python for math beyond simple arithmetic, parsing structured data, regex work, statistics, plotting, or any task where executing code is more reliable than reasoning out the answer.
- Variables, imports, and installed packages persist across run_python calls within this chat. Build on prior state instead of reimporting every call.
- numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, beautifulsoup4, requests and plotly are bundled: just import them. Other packages install automatically on first import.
- Charts you draw in run_python show in the chat on their own. Never link to an image file in your reply: it will not display.
- Do NOT use run_python to create PDFs, Word docs, PowerPoint decks, or spreadsheets. fs_write_document (.pdf/.docx/.odt), fs_write_spreadsheet (.xlsx/.ods) and fs_write_slides (.pptx/.odp) produce much better output than fpdf2 / python-pptx scripts. Use Python for the analysis. For a slide deck, pass the numbers to fs_write_slides as a chart or table, which stays editable in PowerPoint. For a document, save any plots as PNG files in the working directory with matplotlib's savefig and reference them in the content.
- Do NOT use run_python to reach a service listed under CONNECTED INTEGRATIONS. Use that service's own tools.
- If the sandbox state gets stuck (a hung import, a poisoned variable, an unrecoverable exception), call reset_python and start over. Don't reach for it casually — resets wipe everything in the session.
- Tool results include stdout, stderr, the value of the final expression, and any artifacts (plots, tables) the UI rendered for the user. You see the text; the user also sees the rich artifacts.${sandboxFsSection}`
				: ''
		}

Be concise, accurate, and helpful. When in doubt, search.
${
	getSettings().customSystemPrompt.trim()
		? `
CUSTOM INSTRUCTIONS (from the user):
${getSettings().customSystemPrompt.trim()}
`
		: ''
}
${[
	getResponseFormatPrompt(),
	imagesSection,
	imageModelsSection,
	memorySection,
	opts.skillsSection
].join('')}`
	};
}

/**
 * Augment the messages array with per-turn hints based on the user's
 * message content and current settings. Appends hint text to the last
 * user message. Returns the modified array.
 */
export function injectMessageHints(
	messages: ChatMessage[],
	opts: {
		workingDir: string | null;
		exhaustiveResearch: boolean;
		/** A lean Chat turn: it has no fs_write_* tools to be pushed toward. */
		lean?: boolean;
	}
): ChatMessage[] {
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== 'user') return messages;

	const hints: string[] = [];
	// Only what the user typed: a `/name` run carries the skill's instructions
	// ahead of it, and their wording ("records", "best match") is not a request.
	const fullText = messageText(lastMsg.content);
	const lastText = typedText(fullText);
	// The skill's own steps say how much to research, so the research hints
	// below stay out of a skill run.
	const runsSkill = lastText !== fullText;

	if (!runsSkill && looksLikeReviewQuery(lastText)) {
		hints.push('Include Reddit as a source.');
	}

	if (opts.workingDir && !opts.lean && looksLikeFileOutputRequest(lastText)) {
		hints.push(
			'You must create the requested file DURING THIS TURN. Do your research, ' +
				'synthesize the content, then write the file: fs_write_document for ' +
				'.pdf/.docx/.odt, fs_write_spreadsheet for .xlsx/.ods, fs_write_slides ' +
				'for .pptx/.odp. ' +
				'Do NOT use run_python to generate the document — the dedicated ' +
				'fs_write_* tools produce better output than fpdf2 / python-pptx ' +
				'scripts. Do NOT paste the report as a chat message and expect the ' +
				'user to ask again in a follow-up — that wastes a round trip and ' +
				'risks running out of context on the retry. After the write succeeds, ' +
				'respond with a brief confirmation and the file path.'
		);
	}

	if (opts.exhaustiveResearch && !runsSkill) {
		hints.push(
			'Research this thoroughly. Perform multiple searches from different angles. ' +
				'Read at least 4-6 sources before answering. Include diverse viewpoints. ' +
				'For every source you read, use research_url (not fetch_url) and pass a ' +
				'specific focus describing what you are looking for on that page — for ' +
				'example "pricing tiers and free plan limits", "criticisms or downsides", ' +
				'or "verbatim claims about deployment latency". Each call processes one URL; ' +
				'put the calls for several sources in one response.'
		);
	}

	if (hints.length === 0) return messages;

	const suffix = '\n\n(' + hints.join(' ') + ')';
	const result = [...messages];
	if (typeof lastMsg.content === 'string') {
		result[result.length - 1] = { ...lastMsg, content: lastMsg.content + suffix };
	} else {
		const parts = [...lastMsg.content];
		const textIdx = parts.findIndex((p) => p.type === 'text');
		if (textIdx >= 0) {
			const textPart = parts[textIdx] as { type: 'text'; text: string };
			parts[textIdx] = { type: 'text', text: textPart.text + suffix };
		} else {
			parts.push({ type: 'text', text: suffix.trim() });
		}
		result[result.length - 1] = { ...lastMsg, content: parts };
	}
	return result;
}
