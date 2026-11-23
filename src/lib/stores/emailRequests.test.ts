import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import {
	countEmailRequestsSince,
	emailRequestByReplyId,
	emailRequestThread,
	getEmailRequest,
	insertEmailRequest,
	listEmailRequests,
	openEmailRequests,
	pruneEmailRequests,
	updateEmailRequest
} from './emailRequests';

const call = vi.mocked(invoke);

describe('emailRequests', () => {
	beforeEach(() => call.mockClear());

	it('calls each command with its argument names', async () => {
		const row = {
			jobId: 3,
			messageId: 'a@x',
			threadId: 'a@x',
			references: [],
			subject: 's',
			state: 'waiting_sent'
		};
		await getEmailRequest(3, 'a@x');
		await insertEmailRequest(row);
		await updateEmailRequest(9, { state: 'answered', reason: '' });
		await listEmailRequests(3, 20);
		await openEmailRequests(3);
		await emailRequestThread(3, 'root@x');
		await emailRequestByReplyId('reply@x');
		await countEmailRequestsSince(3, 1000);
		await pruneEmailRequests(3);
		expect(call.mock.calls).toEqual([
			['db_email_requests_get', { jobId: 3, messageId: 'a@x' }],
			['db_email_requests_insert', { row }],
			['db_email_requests_update', { id: 9, patch: { state: 'answered', reason: '' } }],
			['db_email_requests_list', { jobId: 3, limit: 20 }],
			['db_email_requests_open', { jobId: 3 }],
			['db_email_requests_thread', { jobId: 3, threadId: 'root@x' }],
			['db_email_requests_by_reply_id', { replyMessageId: 'reply@x' }],
			['db_email_requests_count_since', { jobId: 3, sinceMs: 1000 }],
			['db_email_requests_prune', { jobId: 3 }]
		]);
	});

	it('passes a failure on instead of hiding it', async () => {
		call.mockRejectedValueOnce(new Error('database is locked'));
		await expect(getEmailRequest(3, 'a@x')).rejects.toThrow('database is locked');
	});
});
