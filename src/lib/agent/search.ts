import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { detectPaywall } from '$lib/agent/paywall';
import { getSettings, getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';

// Sub-agent token cap. Generous on purpose: a treasure-trove page should be
// able to return rich findings without artificial truncation. The model will
// hit EOS naturally well before this for most pages, but having headroom
// avoids cutting off the one source that has all the answers.
const RESEARCH_AGENT_MAX_TOKENS = 3072;

/**
 * Result of a single tool invocation. `result` is the string the agent
 * loop sends back to the model as the tool message content. Optional
 * attachments are side-channel data for the chat UI — currently just an
 * inline thumbnail data URL for image-producing tools (fs_read_image,
 * fs_download_url on an image extension). Anything else the model sees
 * belongs in `result`.
 */
export interface ToolExecOutput {
	result: string;
	thumbDataUrl?: string;
}

// Small helper to wrap a plain-string result so the switch arms stay
// readable. 99% of tools don't produce attachments.
const r = (s: string): ToolExecOutput => ({ result: s });

// Regex for file extensions we can preview as a thumbnail inline. The
// chat UI reads the bytes back via fs_read_image and renders a data URL.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;

/**
 * Outcome of pre-write conflict resolution. `null` means the user
 * canceled and the caller should NOT invoke the underlying write
 * command — instead, return an error string to the model telling it
 * to stop and ask the user.
 */
interface ResolvedWritePath {
	finalPath: string;
	overwrite: boolean;
}

/**
 * Check whether a write to `relPath` would clobber an existing file,
 * and if so, show the file-conflict modal to let the user pick. Called
 * by every executeFsWrite_/executeFsDownloadUrl wrapper before the
 * actual tool invocation.
 *
 * Fast paths:
 *   - If `relPath` is in `filesWrittenThisTurn`, the model is iterating
 *     on a file it created earlier in the same turn (write → read →
 *     correct → write). Allow the overwrite silently — the modal would
 *     be disruptive for this common iteration loop.
 *   - Else, call `fs_path_exists`. If the file doesn't exist, proceed
 *     with `overwrite=false` (which is harmless since there's nothing
 *     to clobber, but kept explicit for the Rust-side safety net).
 *
 * Slow path (file exists AND not in the per-turn set):
 *   - Call `askFileConflict(relPath)` which shows the modal and awaits
 *     the user's click.
 *   - 'overwrite' → return the original path with overwrite=true
 *   - 'counter'   → call `fs_find_available_path` for the next unused
 *                   name and return that with overwrite=false
 *   - 'cancel'    → return null, caller surfaces a "user canceled"
 *                   error string to the model
 */
async function resolveWritePathInteractive(
	workdir: string,
	relPath: string,
	filesWrittenThisTurn: Set<string>
): Promise<ResolvedWritePath | null> {
	// Iteration case: we wrote this file earlier in this same turn.
	// Implicit overwrite — no modal, no friction.
	if (filesWrittenThisTurn.has(relPath)) {
		return { finalPath: relPath, overwrite: true };
	}

	// Does the file exist on disk right now?
	let exists = false;
	try {
		exists = await invoke<boolean>('fs_path_exists', { workdir, relPath });
	} catch {
		// If the existence check itself errors, fall through as if the
		// file doesn't exist — the Rust-side refuse_if_exists will catch
		// any actual conflict that reaches the write command.
		exists = false;
	}
	if (!exists) {
		return { finalPath: relPath, overwrite: false };
	}

	// Pre-existing file, not written by us this turn. Ask the user.
	// Lazy-imported to avoid a module graph cycle with any future file
	// that imports search.ts from the store layer.
	const { askFileConflict } = await import('$lib/stores/fileConflict.svelte');
	const choice = await askFileConflict(relPath);
	if (choice === 'cancel') {
		return null;
	}
	if (choice === 'overwrite') {
		return { finalPath: relPath, overwrite: true };
	}
	// 'counter' — find an unused name like "report-2.pdf".
	try {
		const newPath = await invoke<string>('fs_find_available_path', {
			workdir,
			relPath
		});
		return { finalPath: newPath, overwrite: false };
	} catch (e) {
		// If the counter helper itself fails, fall back to overwrite so
		// the user's intent ("don't lose either file") is at least
		// approximately respected — but this shouldn't happen in practice.
		console.error('fs_find_available_path failed:', e);
		return { finalPath: relPath, overwrite: true };
	}
}

/**
 * Shared error result for the "user canceled the write" path. Kept as
 * a helper so the message stays consistent across every wrapper.
 */
function userCanceledWriteError(relPath: string, toolName: string): ToolExecOutput {
	return r(
		JSON.stringify({
			error: `User canceled the ${toolName} write. The file "${relPath}" already exists in the working directory and the user chose to stop instead of overwriting or renaming. Do NOT retry automatically — stop what you were doing, briefly explain to the user that the file already exists, and ask them how they'd like to proceed (pick a different filename, overwrite the existing file, or skip the write entirely).`
		})
	);
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export async function executeWebSearch(
	query: string,
	deepResearch: boolean = false
): Promise<string> {
	try {
		const settings = getSettings();
		const results = await invoke<SearchResult[]>('proxy_search', {
			query,
			provider: settings.searchProvider,
			apiKey: settings.braveApiKey || null,
			instanceUrl: settings.searxngUrl || null,
			recency: settings.searchRecency || null,
			deepResearch
		});
		return JSON.stringify(results);
	} catch (e) {
		return JSON.stringify({ error: `Search failed: ${e}` });
	}
}

/**
 * Build the string the model sees when we reject a URL as paywalled.
 * Kept as a helper so `fetch_url` and `research_url` produce the same
 * prefix — the agent loop and source-extraction code both key off the
 * literal "Paywalled:" start to skip source numbering for the URL.
 */
function paywallErrorMessage(url: string, reason: string): string {
	return (
		`Paywalled: ${url} — ${reason}. Do NOT cite any facts from this URL; ` +
		`whatever text you might see would be a teaser or login gate, not the ` +
		`real article. Search for an alternative source that is freely readable.`
	);
}

export async function executeFetchUrl(url: string): Promise<string> {
	try {
		const content = await invoke<string>('proxy_fetch', { url, caller: 'fetch_url' });
		const paywall = detectPaywall(url, content);
		if (paywall.paywalled) {
			return paywallErrorMessage(url, paywall.reason || 'page is paywalled');
		}
		return content;
	} catch (e) {
		return `Failed to fetch URL: ${e}`;
	}
}

/**
 * Run a single-URL research sub-agent. Fetches the page, then dispatches
 * an isolated chatCompletion call (no tools, no chat history) that asks
 * a focused extractor prompt to pull out only the parts of the page that
 * answer the model's `focus`. Returns just the findings — typically far
 * smaller than the raw page text — so the main agent loop can fan out
 * across many sources without saturating its own context window.
 *
 * Sub-agents run sequentially through the existing llama-server slot.
 * On llama.cpp, parallel slots provide little benefit for token
 * generation (continuous batching helps prefill, but decode is
 * memory-bandwidth bound and per-request rate degrades), so the gain
 * here is from context isolation, not concurrent compute.
 */
export async function executeResearchUrl(
	url: string,
	focus: string,
	signal?: AbortSignal
): Promise<string> {
	// Fetch the raw page content first. If the fetch failed, surface the
	// error verbatim — there's no point spinning up a sub-agent on nothing.
	let pageContent: string;
	try {
		pageContent = await invoke<string>('proxy_fetch', { url, caller: 'research_url' });
	} catch (e) {
		return `Failed to fetch URL: ${e}`;
	}
	if (!pageContent || pageContent.startsWith('Failed to fetch')) {
		return pageContent || `Failed to fetch URL: ${url}`;
	}

	// Paywall check: the Rust fetcher flags pages that carry a standard
	// Schema.org / OpenGraph paywall marker via a sentinel prefix, and
	// this call additionally catches short gated stubs that don't emit
	// the metadata. Either way, skip the sub-agent — it can't extract
	// real findings from a login wall and will happily fabricate them.
	const paywall = detectPaywall(url, pageContent);
	if (paywall.paywalled) {
		return paywallErrorMessage(url, paywall.reason || 'page is paywalled');
	}

	const systemPrompt =
		'You are a focused research assistant. You will be given the text of a single web page and a specific focus question. Your job is to extract from the page only the information that is relevant to the focus question, and return it as concise findings.\n\n' +
		'Rules:\n' +
		'- Quote specific facts, numbers, names, and dates verbatim from the page.\n' +
		'- Use bullet points organized by sub-topic when helpful.\n' +
		'- Do not summarize parts of the page that are not relevant to the focus.\n' +
		'- Do not invent or extrapolate — every claim must be supported by the page text.\n' +
		'- If the page contains no information relevant to the focus, reply with exactly: "No relevant information found on this page."\n' +
		'- Do not add preamble, meta-commentary, or closing remarks. Output only the findings.';

	const userPrompt =
		`Focus: ${focus}\n\n` +
		`Page URL: ${url}\n\n` +
		`Page content:\n${pageContent}\n\n` +
		`Extract from the page above only the information relevant to the focus.`;

	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];

	try {
		const sampling = getSamplingParams();
		const response = await chatCompletion(
			{
				messages,
				temperature: sampling.temperature,
				top_p: sampling.top_p,
				max_tokens: RESEARCH_AGENT_MAX_TOKENS,
				chat_template_kwargs: getChatTemplateKwargs()
			},
			signal
		);
		const findings = response.content?.trim();
		if (!findings) {
			return `Sub-agent returned no findings for ${url}.`;
		}
		// Tag the result with the URL so the main agent can cite it.
		return `Source: ${url}\nFocus: ${focus}\n\n${findings}`;
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		return `Research sub-agent failed for ${url}: ${e}`;
	}
}

// --- Email integration dispatch ---

/** Upper bound on sub-agent output tokens when summarizing one email. */
const EMAIL_SUMMARY_MAX_TOKENS = 400;

interface EmailListing {
	accountId: string;
	accountLabel: string;
	messageId: string;
	subject: string;
	fromName: string;
	fromEmail: string;
	date: string;
	snippet: string;
	hasAttachments: boolean;
}

interface NormalizedEmailMessage {
	accountId: string;
	accountLabel: string;
	messageId: string;
	subject: string;
	fromName: string;
	fromEmail: string;
	to: string[];
	date: string;
	body: string;
	hasAttachments: boolean;
}

interface EmailSummarizerInput {
	subject: string;
	fromName: string;
	fromEmail: string;
	date: string;
	body: string;
}

/**
 * Resolve an account selector from a tool-call argument to a concrete
 * stored `EmailAccount` list. The selector (`account_id` in the tool
 * schema) is tolerant:
 *
 * - An exact UUID match wins (this is what previous listings return
 *   as the `accountId` field, so round-tripping through the model
 *   always works).
 * - Falling back, a case-insensitive match on the user-facing label
 *   ("Work Gmail", "Personal") — lets the model translate user
 *   intent like "summarize my work email" directly into a call.
 * - Empty / undefined selector returns all enabled accounts (the
 *   multi-account fan-out case for `email_list_recent`).
 *
 * Always filters to enabled accounts — a disabled account is treated
 * as if it doesn't exist.
 */
function resolveEmailAccounts(
	selector?: string
): Array<import('$lib/stores/settings').EmailAccount> {
	const all = getSettings().integrations.email.accounts.filter((a) => a.enabled);
	if (!selector) return all;
	const byId = all.filter((a) => a.id === selector);
	if (byId.length > 0) return byId;
	const needle = selector.trim().toLowerCase();
	return all.filter((a) => a.label.trim().toLowerCase() === needle);
}

export async function executeEmailListRecent(args: Record<string, unknown>): Promise<string> {
	const accountId = args.account_id as string | undefined;
	const accounts = resolveEmailAccounts(accountId);
	if (accounts.length === 0) {
		return JSON.stringify({
			error: accountId
				? `No enabled email account with id ${accountId}.`
				: 'No email accounts are enabled. Ask the user to add one in Settings → Integrations.'
		});
	}

	// Fan out across accounts. In practice there are usually 1-3.
	const all: EmailListing[] = [];
	for (const account of accounts) {
		try {
			const listings = await invoke<EmailListing[]>('email_list_recent', {
				account,
				hours: (args.hours as number | undefined) ?? null,
				sinceDate: (args.since_date as string | undefined) ?? null,
				from: (args.from as string | undefined) ?? null,
				subjectContains: (args.subject_contains as string | undefined) ?? null,
				maxResults: (args.max_results as number | undefined) ?? null
			});
			all.push(...listings);
		} catch (e) {
			// One broken account shouldn't kill the rest — capture the
			// error as a synthetic listing so the model can see that the
			// account had a problem without abandoning the whole call.
			all.push({
				accountId: account.id,
				accountLabel: account.label,
				messageId: `error-${account.id}`,
				subject: `[error fetching ${account.label}]`,
				fromName: '',
				fromEmail: '',
				date: '',
				snippet: String(e),
				hasAttachments: false
			});
		}
	}

	// Sort all accounts' results together by date descending.
	all.sort((a, b) => b.date.localeCompare(a.date));

	const maxResults = (args.max_results as number | undefined) ?? 20;
	const trimmed = all.slice(0, maxResults);
	return JSON.stringify(trimmed);
}

export async function executeEmailReadFull(args: Record<string, unknown>): Promise<string> {
	const accountId = args.account_id as string;
	const messageId = args.message_id as string;
	const [account] = resolveEmailAccounts(accountId);
	if (!account) {
		return JSON.stringify({ error: `No enabled email account with id ${accountId}.` });
	}
	try {
		const msg = await invoke<NormalizedEmailMessage>('email_read_full', {
			account,
			messageId
		});
		return JSON.stringify(msg);
	} catch (e) {
		return JSON.stringify({ error: `email_read_full failed: ${e}` });
	}
}

/**
 * Sub-agent compression for a single email message. Fetches the
 * prepared summarizer input from the backend (which already does
 * quoted-reply stripping and truncation), then calls the local or
 * remote inference backend with a focused system prompt. The
 * returned string is the compressed summary — the full body never
 * enters the caller's context.
 *
 * Mirrors `executeResearchUrl` — both exist to save main-agent
 * context tokens at the cost of one extra chat completion per input.
 */
export async function executeEmailSummarizeMessage(
	args: Record<string, unknown>,
	signal?: AbortSignal
): Promise<string> {
	const accountId = args.account_id as string;
	const messageId = args.message_id as string;
	const focus = (args.focus as string | undefined) ?? '';

	const [account] = resolveEmailAccounts(accountId);
	if (!account) {
		return JSON.stringify({ error: `No enabled email account with id ${accountId}.` });
	}

	// Step 1: fetch + prep on the Rust side.
	let input: EmailSummarizerInput;
	try {
		input = await invoke<EmailSummarizerInput>('email_prepare_summary', {
			account,
			messageId
		});
	} catch (e) {
		return JSON.stringify({ error: `email_prepare_summary failed: ${e}` });
	}

	if (!input.body.trim()) {
		return `Message has no body content. From ${input.fromName || input.fromEmail}, subject ${input.subject}.`;
	}

	// Step 2: focused sub-agent chat completion. Same pattern as
	// executeResearchUrl — short system prompt, one user turn, no
	// tools, bounded output budget.
	const systemPrompt =
		'You are an email summarizer. Given ONE email message, produce a short, factual summary for a busy reader.\n\n' +
		'Rules:\n' +
		'- 2-4 sentences, plain prose, no markdown.\n' +
		'- Cover who sent it, what it is about, and any action the sender is asking for.\n' +
		'- Name any concrete dates, amounts, or deadlines mentioned in the body.\n' +
		'- Do NOT refuse to summarize marketing or promotional content — note the category and the key offer.\n' +
		'- Do NOT add preamble, meta-commentary, or closing remarks. Output only the summary text.';

	const focusLine = focus ? `Focus: ${focus}\n\n` : '';
	const userPrompt =
		`${focusLine}From: ${input.fromName} <${input.fromEmail}>\n` +
		`Date: ${input.date}\n` +
		`Subject: ${input.subject}\n\n` +
		`Body:\n${input.body}`;

	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt }
	];

	try {
		const sampling = getSamplingParams();
		const response = await chatCompletion(
			{
				messages,
				temperature: sampling.temperature,
				top_p: sampling.top_p,
				max_tokens: EMAIL_SUMMARY_MAX_TOKENS,
				chat_template_kwargs: getChatTemplateKwargs()
			},
			signal
		);
		const summary = response.content?.trim();
		if (!summary) {
			// Fallback: if the sub-agent returned nothing, surface a
			// minimal placeholder so the main agent still has something
			// to cite instead of an empty blob.
			return JSON.stringify({
				accountId: input.fromEmail ? account.id : '',
				messageId,
				subject: input.subject,
				from: `${input.fromName} <${input.fromEmail}>`,
				date: input.date,
				summary: `[summarizer returned nothing — body preview: ${input.body.slice(0, 200)}]`
			});
		}
		return JSON.stringify({
			accountId: account.id,
			messageId,
			subject: input.subject,
			from: `${input.fromName} <${input.fromEmail}>`,
			date: input.date,
			summary
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		return JSON.stringify({ error: `email_summarize_message sub-agent failed: ${e}` });
	}
}

// --- Filesystem tool dispatch ---

interface DirListing {
	path: string;
	entries: Array<{ name: string; is_dir: boolean; size: number }>;
	truncated: boolean;
}

function formatDirListing(listing: DirListing): string {
	const lines: string[] = [`Directory: ${listing.path}`];
	if (listing.entries.length === 0) {
		lines.push('(empty)');
	}
	for (const entry of listing.entries) {
		const marker = entry.is_dir ? '[DIR] ' : '      ';
		const size = entry.is_dir ? '' : ` (${entry.size} bytes)`;
		lines.push(`${marker}${entry.name}${size}`);
	}
	if (listing.truncated) {
		lines.push('... (listing truncated; more than 500 entries)');
	}
	return lines.join('\n');
}

async function executeFsListDir(workdir: string, relPath: string): Promise<string> {
	try {
		const listing = await invoke<DirListing>('fs_list_dir', { workdir, relPath });
		return formatDirListing(listing);
	} catch (e) {
		return JSON.stringify({ error: `fs_list_dir failed: ${e}` });
	}
}

async function executeFsReadText(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_text', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_text failed: ${e}` });
	}
}

async function executeFsReadPdf(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_pdf', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_pdf failed: ${e}` });
	}
}

async function executeFsReadDocx(workdir: string, relPath: string): Promise<string> {
	try {
		return await invoke<string>('fs_read_docx', { workdir, relPath });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_docx failed: ${e}` });
	}
}

async function executeFsReadXlsx(
	workdir: string,
	relPath: string,
	sheet?: string
): Promise<string> {
	try {
		return await invoke<string>('fs_read_xlsx', { workdir, relPath, sheet });
	} catch (e) {
		return JSON.stringify({ error: `fs_read_xlsx failed: ${e}` });
	}
}

async function executeFsWriteDocx(
	workdir: string,
	relPath: string,
	content: string,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_docx');
	try {
		await invoke('fs_write_docx', {
			workdir,
			relPath: resolved.finalPath,
			content,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(`Wrote docx: ${resolved.finalPath}`);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_docx failed: ${e}` }));
	}
}

async function executeFsWritePdf(
	workdir: string,
	relPath: string,
	content: string,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_pdf');
	try {
		await invoke('fs_write_pdf', {
			workdir,
			relPath: resolved.finalPath,
			content,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(`Wrote pdf: ${resolved.finalPath}`);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_pdf failed: ${e}` }));
	}
}

interface XlsxSheet {
	name: string;
	rows: string[][];
}

async function executeFsWriteXlsx(
	workdir: string,
	relPath: string,
	sheets: XlsxSheet[],
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_xlsx');
	try {
		await invoke('fs_write_xlsx', {
			workdir,
			relPath: resolved.finalPath,
			sheets,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(
			`Wrote xlsx: ${resolved.finalPath} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'})`
		);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_xlsx failed: ${e}` }));
	}
}

async function executeFsWriteOdt(
	workdir: string,
	relPath: string,
	content: string,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_odt');
	try {
		await invoke('fs_write_odt', {
			workdir,
			relPath: resolved.finalPath,
			content,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(`Wrote odt: ${resolved.finalPath}`);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_odt failed: ${e}` }));
	}
}

async function executeFsWriteOds(
	workdir: string,
	relPath: string,
	sheets: XlsxSheet[],
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_ods');
	try {
		// ODS reuses the XlsxSheet shape — same { name, rows } structure
		await invoke('fs_write_ods', {
			workdir,
			relPath: resolved.finalPath,
			sheets,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(
			`Wrote ods: ${resolved.finalPath} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'})`
		);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_ods failed: ${e}` }));
	}
}

// A bullet can be either a plain string (level 0) or an object with an
// explicit level. Matches the Rust `PptxBullet` untagged serde enum.
type PptxBulletInput = string | { text: string; level?: number };

interface ImageSearchResult {
	title: string;
	url: string;
	thumb_url: string;
	width: number;
	height: number;
	mime: string;
	license: string;
	attribution: string;
	description_url: string;
}

interface PageImage {
	src: string;
	alt: string;
	width: number | null;
	height: number | null;
}

async function executeFetchUrlImages(url: string): Promise<string> {
	try {
		const images = await invoke<PageImage[]>('proxy_fetch_url_images', { url });
		if (images.length === 0) {
			return JSON.stringify({
				images: [],
				note: `No images found on ${url}. The page may be client-rendered or blocked.`
			});
		}
		return JSON.stringify({ images });
	} catch (e) {
		return JSON.stringify({ error: `fetch_url_images failed: ${e}` });
	}
}

async function executeImageSearch(query: string, maxResults?: number): Promise<string> {
	try {
		const results = await invoke<ImageSearchResult[]>('proxy_image_search', {
			query,
			maxResults: maxResults ?? null
		});
		if (results.length === 0) {
			return JSON.stringify({
				results: [],
				note: `No Wikimedia Commons images found for "${query}". Try a broader or different query.`
			});
		}
		return JSON.stringify({ results });
	} catch (e) {
		return JSON.stringify({ error: `image_search failed: ${e}` });
	}
}

async function executeFsDownloadUrl(
	workdir: string,
	url: string,
	relPath: string,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_download_url');
	try {
		const message = await invoke<string>('fs_download_url', {
			workdir,
			url,
			relPath: resolved.finalPath,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		// If the downloaded file is an image, load it back as a data URL
		// so the chat UI can show a thumbnail inline under the tool step.
		// The model only sees the short text `message` — the data URL is
		// a side-channel attachment that doesn't count against its context.
		let thumbDataUrl: string | undefined;
		if (IMAGE_EXT_RE.test(resolved.finalPath)) {
			try {
				thumbDataUrl = await invoke<string>('fs_read_image', {
					workdir,
					relPath: resolved.finalPath
				});
			} catch {
				// Thumbnail is best-effort — a failure here shouldn't make
				// the download itself look like it failed.
			}
		}
		return { result: message, thumbDataUrl };
	} catch (e) {
		return r(JSON.stringify({ error: `fs_download_url failed: ${e}` }));
	}
}

interface PptxSlide {
	title: string;
	bullets?: PptxBulletInput[];
	subtitle?: string;
	image?: string;
	layout?: 'content' | 'section';
}

async function executeFsWritePptx(
	workdir: string,
	relPath: string,
	slides: PptxSlide[],
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_pptx');
	try {
		await invoke('fs_write_pptx', {
			workdir,
			relPath: resolved.finalPath,
			slides,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(
			`Wrote pptx: ${resolved.finalPath} (${slides.length} slide${slides.length === 1 ? '' : 's'})`
		);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_pptx failed: ${e}` }));
	}
}

async function executeFsWriteOdp(
	workdir: string,
	relPath: string,
	slides: PptxSlide[],
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_odp');
	try {
		// ODP reuses the PptxSlide shape — same { title, bullets } structure
		await invoke('fs_write_odp', {
			workdir,
			relPath: resolved.finalPath,
			slides,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(
			`Wrote odp: ${resolved.finalPath} (${slides.length} slide${slides.length === 1 ? '' : 's'})`
		);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_odp failed: ${e}` }));
	}
}

async function executeFsReadImage(
	workdir: string,
	relPath: string,
	pendingImages: Array<{ path: string; dataUrl: string }>
): Promise<ToolExecOutput> {
	try {
		const dataUrl = await invoke<string>('fs_read_image', { workdir, relPath });
		// Two destinations for the same bytes:
		//   - `pendingImages`: queued for the next model turn so the
		//     vision model can actually see the image.
		//   - `thumbDataUrl`: attachment for the chat UI so the user
		//     also gets an inline preview under the tool step.
		pendingImages.push({ path: relPath, dataUrl });
		return {
			result: `Image loaded: ${relPath}. You can now see it — describe or analyze it in your next response.`,
			thumbDataUrl: dataUrl
		};
	} catch (e) {
		return r(JSON.stringify({ error: `fs_read_image failed: ${e}` }));
	}
}

async function executeFsReadPdfPages(
	workdir: string,
	relPath: string,
	pendingImages: Array<{ path: string; dataUrl: string }>
): Promise<string> {
	try {
		// Dynamic import so PDF.js (and its worker) is only loaded when actually used
		const { renderPdfPages } = await import('$lib/agent/pdf-render');
		const pages = await renderPdfPages(workdir, relPath);
		for (let i = 0; i < pages.length; i++) {
			pendingImages.push({ path: `${relPath}#page${i + 1}`, dataUrl: pages[i] });
		}
		return `Rendered ${pages.length} page${pages.length === 1 ? '' : 's'} of ${relPath} as images. You can now see the pages in your next response — read form fields, labels, values, and layout directly.`;
	} catch (e) {
		return JSON.stringify({ error: `fs_read_pdf_pages failed: ${e}` });
	}
}

async function executeFsWriteText(
	workdir: string,
	relPath: string,
	content: string,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, 'fs_write_text');
	try {
		await invoke('fs_write_text', {
			workdir,
			relPath: resolved.finalPath,
			content,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return r(`Wrote ${content.length} bytes to ${resolved.finalPath}`);
	} catch (e) {
		return r(JSON.stringify({ error: `fs_write_text failed: ${e}` }));
	}
}

async function executeFsEditText(
	workdir: string,
	relPath: string,
	oldStr: string,
	newStr: string
): Promise<string> {
	try {
		await invoke('fs_edit_text', { workdir, relPath, oldStr, newStr });
		return `Edited ${relPath}`;
	} catch (e) {
		return JSON.stringify({ error: `fs_edit_text failed: ${e}` });
	}
}

export interface PendingImage {
	path: string;
	dataUrl: string;
}

// Max images per turn. Each ~1024px image is ~500-800 image tokens for
// Qwen3.5-9B vision; batching more than this at once risks blowing out the
// KV cache and crashing llama-server with "find_slot: non-consecutive token
// position" errors. The model should respond about loaded images before
// loading more.
const MAX_PENDING_IMAGES = 6;

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	workingDir: string | null,
	signal?: AbortSignal,
	pendingImages?: PendingImage[],
	deepResearch: boolean = false,
	filesWrittenThisTurn: Set<string> = new Set()
): Promise<ToolExecOutput> {
	switch (name) {
		case 'web_search':
			return r(await executeWebSearch(args.query as string, deepResearch));
		case 'fetch_url':
			return r(await executeFetchUrl(args.url as string));
		case 'research_url':
			return r(await executeResearchUrl(args.url as string, args.focus as string, signal));
		case 'image_search':
			return r(
				await executeImageSearch(args.query as string, args.max_results as number | undefined)
			);
		case 'fetch_url_images':
			return r(await executeFetchUrlImages(args.url as string));
		case 'fs_list_dir':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(await executeFsListDir(workingDir, (args.path as string) ?? '.'));
		case 'fs_read_text':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(await executeFsReadText(workingDir, args.path as string));
		case 'fs_read_pdf':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(await executeFsReadPdf(workingDir, args.path as string));
		case 'fs_read_docx':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(await executeFsReadDocx(workingDir, args.path as string));
		case 'fs_read_xlsx':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(
				await executeFsReadXlsx(workingDir, args.path as string, args.sheet as string | undefined)
			);
		case 'fs_read_image':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			if (!pendingImages)
				return r(JSON.stringify({ error: 'Images not supported in this context' }));
			if (pendingImages.length >= MAX_PENDING_IMAGES) {
				return r(
					JSON.stringify({
						error: `Too many images pending (${pendingImages.length}). Respond about the images you've already loaded before loading more — loading too many images in one turn exhausts the model context and crashes inference.`
					})
				);
			}
			return executeFsReadImage(workingDir, args.path as string, pendingImages);
		case 'fs_read_pdf_pages':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			if (!pendingImages)
				return r(JSON.stringify({ error: 'Images not supported in this context' }));
			if (pendingImages.length > 0) {
				return r(
					JSON.stringify({
						error: `You already have ${pendingImages.length} image(s) pending. Respond about them first, then call fs_read_pdf_pages for the next PDF. Loading multiple PDFs as images in one turn crashes the inference server.`
					})
				);
			}
			return r(await executeFsReadPdfPages(workingDir, args.path as string, pendingImages));
		case 'fs_write_text':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteText(
				workingDir,
				args.path as string,
				args.content as string,
				filesWrittenThisTurn
			);
		case 'fs_write_docx':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteDocx(
				workingDir,
				args.path as string,
				args.content as string,
				filesWrittenThisTurn
			);
		case 'fs_write_pdf':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWritePdf(
				workingDir,
				args.path as string,
				args.content as string,
				filesWrittenThisTurn
			);
		case 'fs_write_xlsx':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteXlsx(
				workingDir,
				args.path as string,
				args.sheets as XlsxSheet[],
				filesWrittenThisTurn
			);
		case 'fs_write_odt':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteOdt(
				workingDir,
				args.path as string,
				args.content as string,
				filesWrittenThisTurn
			);
		case 'fs_write_ods':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteOds(
				workingDir,
				args.path as string,
				args.sheets as XlsxSheet[],
				filesWrittenThisTurn
			);
		case 'fs_write_pptx':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWritePptx(
				workingDir,
				args.path as string,
				args.slides as PptxSlide[],
				filesWrittenThisTurn
			);
		case 'fs_write_odp':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsWriteOdp(
				workingDir,
				args.path as string,
				args.slides as PptxSlide[],
				filesWrittenThisTurn
			);
		case 'fs_download_url':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return executeFsDownloadUrl(
				workingDir,
				args.url as string,
				args.path as string,
				filesWrittenThisTurn
			);
		case 'fs_edit_text':
			if (!workingDir) return r(JSON.stringify({ error: 'No working directory set' }));
			return r(
				await executeFsEditText(
					workingDir,
					args.path as string,
					args.old_str as string,
					args.new_str as string
				)
			);
		case 'email_list_recent':
			return r(await executeEmailListRecent(args));
		case 'email_summarize_message':
			return r(await executeEmailSummarizeMessage(args, signal));
		case 'email_read_full':
			return r(await executeEmailReadFull(args));
		default:
			return r(JSON.stringify({ error: `Unknown tool: ${name}` }));
	}
}
