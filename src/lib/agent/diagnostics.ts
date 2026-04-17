import type { SearchStep } from '$lib/agent/loop';

export type Diagnosis = { type: 'commit'; content: string } | { type: 'error'; message: string };

/**
 * Given an empty final response and the tool steps that ran, return
 * either a synthesized assistant message (e.g. "File written: report.pdf")
 * or an error message explaining what went wrong.
 */
export function diagnoseEmptyResponse(
	searchSteps: SearchStep[],
	streamingContent: string
): Diagnosis {
	const successfulWrite = searchSteps.find(
		(s) =>
			s.toolName.startsWith('fs_write_') &&
			s.status === 'done' &&
			!(s.result || '').includes('"error"')
	);
	const doneSteps = searchSteps.filter((s) => s.status === 'done');
	const anyToolCompleted = doneSteps.length > 0;
	const emailListed = doneSteps.some((s) => s.toolName === 'email_list_recent');
	const emailSummarized = doneSteps.some((s) => s.toolName === 'email_summarize_message');
	const imageSearched = doneSteps.some(
		(s) => s.toolName === 'image_search' || s.toolName === 'fetch_url_images'
	);
	const webResearched = doneSteps.some(
		(s) =>
			s.toolName === 'web_search' || s.toolName === 'fetch_url' || s.toolName === 'research_url'
	);

	if (streamingContent) {
		console.warn(
			'[empty-final-content] streamingContent length=',
			streamingContent.length,
			'first 500 chars:',
			streamingContent.slice(0, 500)
		);
	}

	if (successfulWrite) {
		return { type: 'commit', content: `Done. File written: ${successfulWrite.query}` };
	}
	if (emailListed && !emailSummarized) {
		return {
			type: 'error',
			message:
				'Fetched your email listing but could not produce a summary. ' +
				'The model struggled to emit a valid follow-up tool call. ' +
				'Try a narrower request like "summarize my email from the last 4 hours" ' +
				'or "summarize the 3 most recent emails from alice@example.com" — ' +
				'giving the model a smaller, more focused set is more reliable ' +
				'than asking it to digest a week of messages at once.'
		};
	}
	if (emailListed) {
		return {
			type: 'error',
			message:
				'Email digest run completed but the final summary did not arrive. ' +
				'Try a more focused request ("summarize the 3 most recent", "what did ' +
				'alice send this week?") so the model has less to synthesize.'
		};
	}
	if (imageSearched) {
		return {
			type: 'error',
			message:
				'Research completed but the model did not produce a final answer ' +
				'or file. The image-discovery step may have stalled — try a ' +
				'follow-up like "write the presentation with what you have so far, ' +
				'no images" to force the model to finish.'
		};
	}
	if (webResearched) {
		return {
			type: 'error',
			message:
				'Web research completed but the final answer did not arrive. ' +
				'This usually means the model got stuck after many tool calls. ' +
				'Try a more focused question, disable deep research if enabled, ' +
				'or break the question into smaller pieces.'
		};
	}
	if (anyToolCompleted) {
		return {
			type: 'error',
			message:
				'Tools ran but the model did not produce a final answer. ' +
				'Try rephrasing or a more focused question.'
		};
	}
	return { type: 'error', message: 'Model returned an empty response. Try rephrasing.' };
}
