import { describe, expect, it, vi } from 'vitest';

// Every integration on, so a leak past the allowlist would show.
vi.mock('#lib/stores/settings.ts', async (orig) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(orig, {
		overDefaults: true,
		settings: () => ({
			sandboxEnabled: true,
			screenCaptureEnabled: true,
			musicBackendKind: 'toolchest',
			videoModels: [
				{
					id: 'v',
					name: 'v',
					backend: 'llama-toolchest',
					url: '',
					keyId: null,
					model: 'v',
					options: {},
					caps: null,
					capsAt: null,
					renamed: false
				}
			],
			memoryEnabled: true,
			agentFeedbackEnabled: false
		}),
		hasEnabledEmailAccount: () => true,
		hasSendableEmailAccount: () => true,
		hasEnabledCalendarAccount: () => true,
		hasEnabledContactsAccount: () => true
	})
);

import '#lib/agent/tools/index.ts';
import { offeredSchemas } from '#lib/agent/tools/registry.ts';
import type { EmailRequestRow } from '#lib/stores/emailRequests.ts';
import { newReplyId, RESEARCH_TOOLS, researchMessage } from './prompt';

describe('email research turn', () => {
	it('is offered exactly the four web tools, and recall_result', () => {
		const names = offeredSchemas({
			toolAllowlist: RESEARCH_TOOLS,
			interactive: false,
			deepResearch: true,
			hasWorkingDir: false,
			harnessFeedback: true
		}).map((s) => s.function.name);
		expect(names.sort()).toEqual([
			'fetch_url',
			'haruspex_docs',
			'recall_result',
			'research_url',
			'web_search'
		]);
	});

	it('puts a thread’s earlier answered exchanges before the new question', () => {
		const ex = (n: number, kind = 'answer') =>
			({ question: `q${n}`, answer: `a${n}`, replyKind: kind }) as EmailRequestRow;
		const msg = researchMessage('new one', [ex(1), ex(2, 'failure'), ex(3), ex(4), ex(5)]);
		expect(msg).not.toContain('q1');
		expect(msg).not.toContain('q2');
		expect(msg.indexOf('q3')).toBeLessThan(msg.indexOf('q5'));
		expect(msg.trim().endsWith('new one')).toBe(true);
		expect(researchMessage('alone', [])).toBe('alone');
	});

	it('makes reply ids on the account’s domain', () => {
		expect(newReplyId('me@example.com')).toMatch(/^[0-9a-f-]{36}@example\.com$/);
	});
});
