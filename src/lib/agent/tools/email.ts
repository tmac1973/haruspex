import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { getSettings, getSamplingParams, getChatTemplateKwargs } from '$lib/stores/settings';
import type { EmailAccount } from '$lib/stores/settings';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

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
 * Resolve an account selector to concrete stored EmailAccount(s).
 * Matches by UUID first, then case-insensitive label. Empty/undefined
 * returns all enabled accounts (multi-account fan-out).
 */
function resolveEmailAccounts(selector?: string): EmailAccount[] {
	const all = getSettings().integrations.email.accounts.filter((a) => a.enabled);
	if (!selector) return all;
	const byId = all.filter((a) => a.id === selector);
	if (byId.length > 0) return byId;
	const needle = selector.trim().toLowerCase();
	return all.filter((a) => a.label.trim().toLowerCase() === needle);
}

// --- Registration ---

registerTool({
	category: 'email',
	schema: {
		type: 'function',
		function: {
			name: 'email_list_recent',
			description:
				'List recent email messages. Returns metadata only (subject, sender, date, snippet) — no bodies. Omit account_id to query all enabled accounts.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Optional — target a specific account by accountId UUID or label. Omit to query all enabled accounts.'
					},
					hours: {
						type: 'integer',
						minimum: 1,
						description:
							'Only return messages from the last N hours. Use this for "recent" / "today" / "in the last few hours" requests.'
					},
					since_date: {
						type: 'string',
						description:
							'Alternative date floor in IMAP SINCE format (e.g. "10-Apr-2026"). Mutually exclusive with hours; if both are set, hours wins.'
					},
					from: {
						type: 'string',
						description:
							'Substring filter on the sender. Matched case-insensitively against the From header. Example: "alice" or "example.com".'
					},
					subject_contains: {
						type: 'string',
						description: 'Substring filter on the Subject header. Case-insensitive.'
					},
					max_results: {
						type: 'integer',
						minimum: 1,
						maximum: 50,
						description: 'Upper bound on results. Default 25. Raise to 50 for multi-day windows.'
					}
				}
			}
		}
	},
	displayLabel: () => 'email',
	async execute(args) {
		const accountId = args.account_id as string | undefined;
		const accounts = resolveEmailAccounts(accountId);
		if (accounts.length === 0) {
			return toolResult(
				toolError(
					accountId
						? `No enabled email account with id ${accountId}.`
						: 'No email accounts are enabled. Ask the user to add one in Settings → Integrations.'
				)
			);
		}

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

		all.sort((a, b) => b.date.localeCompare(a.date));

		const maxResults = (args.max_results as number | undefined) ?? 20;
		const trimmed = all.slice(0, maxResults);
		return toolResult(JSON.stringify(trimmed));
	}
});

registerTool({
	category: 'email',
	schema: {
		type: 'function',
		function: {
			name: 'email_summarize_message',
			description:
				'Summarize a single email message via a focused sub-agent. Returns a 2-4 sentence summary covering sender, topic, and action items.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description: 'Account selector — pass the accountId from the listing.'
					},
					message_id: {
						type: 'string',
						description: 'The id of the specific message to summarize (from the listing).'
					},
					focus: {
						type: 'string',
						description:
							'Optional — a specific question to bias the summary toward ("what action does the sender want?", "is there a deadline mentioned?"). Leave blank for a general summary.'
					}
				},
				required: ['account_id', 'message_id']
			}
		}
	},
	displayLabel: () => 'email',
	async execute(args, ctx) {
		const accountId = args.account_id as string;
		const messageId = args.message_id as string;
		const focus = (args.focus as string | undefined) ?? '';

		const [account] = resolveEmailAccounts(accountId);
		if (!account) {
			return toolResult(toolError(`No enabled email account with id ${accountId}.`));
		}

		let input: EmailSummarizerInput;
		try {
			input = await invoke<EmailSummarizerInput>('email_prepare_summary', {
				account,
				messageId
			});
		} catch (e) {
			return toolResult(toolError(`email_prepare_summary failed: ${e}`));
		}

		if (!input.body.trim()) {
			return toolResult(
				`Message has no body content. From ${input.fromName || input.fromEmail}, subject ${input.subject}.`
			);
		}

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
				ctx.signal
			);
			const summary = response.content?.trim();
			if (!summary) {
				return toolResult(
					JSON.stringify({
						accountId: account.id,
						messageId,
						subject: input.subject,
						from: `${input.fromName} <${input.fromEmail}>`,
						date: input.date,
						summary: `[summarizer returned nothing — body preview: ${input.body.slice(0, 200)}]`
					})
				);
			}
			return toolResult(
				JSON.stringify({
					accountId: account.id,
					messageId,
					subject: input.subject,
					from: `${input.fromName} <${input.fromEmail}>`,
					date: input.date,
					summary
				})
			);
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') throw e;
			return toolResult(toolError(`email_summarize_message sub-agent failed: ${e}`));
		}
	}
});

registerTool({
	category: 'email',
	schema: {
		type: 'function',
		function: {
			name: 'email_read_full',
			description:
				'Fetch the full body of a single message verbatim. Use only when the user needs exact text or the summary was insufficient.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description: 'Account selector — pass the accountId from the listing.'
					},
					message_id: {
						type: 'string',
						description: 'The id of the specific message to read (from the listing).'
					}
				},
				required: ['account_id', 'message_id']
			}
		}
	},
	displayLabel: () => 'email',
	async execute(args) {
		const accountId = args.account_id as string;
		const messageId = args.message_id as string;
		const [account] = resolveEmailAccounts(accountId);
		if (!account) {
			return toolResult(toolError(`No enabled email account with id ${accountId}.`));
		}
		try {
			const msg = await invoke<NormalizedEmailMessage>('email_read_full', {
				account,
				messageId
			});
			return toolResult(JSON.stringify(msg));
		} catch (e) {
			return toolResult(toolError(`email_read_full failed: ${e}`));
		}
	}
});
