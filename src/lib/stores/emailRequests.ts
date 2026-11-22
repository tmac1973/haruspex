/**
 * Research by email's record: typed wrappers over the `db_email_requests_*`
 * commands. They throw on failure rather than fall back, because the job
 * must stop, not answer a request twice, when it can't read what it has seen.
 */
import { invoke } from '@tauri-apps/api/core';
import type { EmailRequestPatch } from '#lib/ipc/gen/EmailRequestPatch.ts';
import type { EmailRequestRow } from '#lib/ipc/gen/EmailRequestRow.ts';
import type { NewEmailRequest } from '#lib/ipc/gen/NewEmailRequest.ts';

export type { EmailRequestPatch, EmailRequestRow, NewEmailRequest };

export type EmailRequestState =
	'waiting_sent' | 'researching' | 'sending' | 'answered' | 'failed' | 'ignored';

export type EmailRequestReason = 'no_sent_copy' | 'daily_limit' | 'research_failed' | 'send_failed';

/** The job's row for one request, or null when it hasn't seen it. */
export function getEmailRequest(jobId: number, messageId: string): Promise<EmailRequestRow | null> {
	return invoke<EmailRequestRow | null>('db_email_requests_get', { jobId, messageId });
}

/** Record a request the job hasn't seen; false when it already had it. */
export function insertEmailRequest(row: NewEmailRequest): Promise<boolean> {
	return invoke<boolean>('db_email_requests_insert', { row });
}

/** Change the fields given; `reason: ''` clears the reason. */
export function updateEmailRequest(id: number, patch: EmailRequestPatch): Promise<void> {
	return invoke<void>('db_email_requests_update', { id, patch });
}

/** The job's latest rows, newest first. */
export function listEmailRequests(jobId: number, limit: number): Promise<EmailRequestRow[]> {
	return invoke<EmailRequestRow[]>('db_email_requests_list', { jobId, limit });
}

/** The job's unfinished rows (waiting, researching, sending), oldest first. */
export function openEmailRequests(jobId: number): Promise<EmailRequestRow[]> {
	return invoke<EmailRequestRow[]>('db_email_requests_open', { jobId });
}

/** One thread's rows, oldest first. */
export function emailRequestThread(jobId: number, threadId: string): Promise<EmailRequestRow[]> {
	return invoke<EmailRequestRow[]>('db_email_requests_thread', { jobId, threadId });
}

/** The row, in any job, whose reply has this Message-ID. */
export function emailRequestByReplyId(replyMessageId: string): Promise<EmailRequestRow | null> {
	return invoke<EmailRequestRow | null>('db_email_requests_by_reply_id', { replyMessageId });
}

/** How many of the job's requests were claimed for research since `sinceMs`. */
export function countEmailRequestsSince(jobId: number, sinceMs: number): Promise<number> {
	return invoke<number>('db_email_requests_count_since', { jobId, sinceMs });
}

/** Drop the job's old finished rows; returns how many went. */
export function pruneEmailRequests(jobId: number): Promise<number> {
	return invoke<number>('db_email_requests_prune', { jobId });
}
