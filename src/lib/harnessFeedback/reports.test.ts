import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
	countBy,
	issueSummary,
	issueUrl,
	reportsMarkdown,
	shareReports,
	type StoredReport
} from '#lib/harnessFeedback/reports.ts';

function report(over: Partial<StoredReport> = {}): StoredReport {
	return {
		origin: 'tool',
		tool: 'fetch_url',
		kind: 'missing_capability',
		what_happened: 'GitHub API refused as application/json.',
		expected: 'JSON returned as text.',
		mode: 'chat',
		model: 'qwen',
		trace: [
			{ tool: 'fetch_url', args: '{"url":"u"}', result: 'Content type not supported', error: true }
		],
		recorded_at: '2026-10-26T17:00:00Z',
		app_version: '0.2.12',
		os: 'linux',
		...over
	};
}

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe('summaries', () => {
	const reports = [
		report(),
		report({ tool: 'research_url', kind: 'misleading_result', origin: 'reflection' }),
		report({ tool: 'none', suggestion: 'Add a raw fetch.' })
	];

	it('counts most common first', () => {
		expect(countBy(reports, (r) => r.kind)).toEqual([
			['missing_capability', 2],
			['misleading_result', 1]
		]);
	});

	it('writes every report and its calls into the Markdown', () => {
		const md = reportsMarkdown(reports);
		expect(md).toContain('3 reports, newest first.');
		expect(md).toContain('- no tool (missing capability): 1');
		expect(md).toContain('## research_url: misleading result');
		expect(md).toContain('job review · qwen');
		expect(md).toContain('**Suggestion:** Add a raw fetch.');
		expect(md).toContain('### fetch_url (failed)');
	});

	it('keeps the issue text short enough for a URL', () => {
		const many = Array.from({ length: 80 }, (_, i) =>
			report({ what_happened: `problem ${i} ` + 'x'.repeat(400) })
		);
		const body = issueSummary(many, 'f.zip');
		expect(body.length).toBeLessThan(5_300);
		expect(body).toContain('Attach f.zip below');
		expect(body).toMatch(/…and \d+ more in the zip\./);
		const url = issueUrl(many, body, 'linux');
		expect(url).toContain('template=feedback.yml');
		expect(new URL(url).searchParams.get('title')).toBe('[Model feedback] 80 reports from qwen');
		expect(url.length).toBeLessThan(8_000);
	});
});

describe('shareReports', () => {
	it('saves the shown reports, opens their folder, then the issue', async () => {
		mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
			if (cmd === 'feedback_redact')
				return (args.lines as string[]).map((l) => l.replace('GitHub', '[r]'));
			if (cmd === 'agent_feedback_export')
				return { path: '/home/me/Downloads/haruspex-model-feedback-2026-10-26.zip', count: 1 };
			return undefined;
		});
		const r = await shareReports([report()]);
		expect(r).toEqual({
			path: '/home/me/Downloads/haruspex-model-feedback-2026-10-26.zip',
			count: 1
		});
		expect(mocks.invoke.mock.calls.map((c) => c[0])).toEqual([
			'agent_feedback_export',
			'folder_open',
			'feedback_redact',
			'open_url'
		]);
		const exported = mocks.invoke.mock.calls[0][1] as { summary: string; reports: StoredReport[] };
		expect(exported.reports).toHaveLength(1);
		expect(exported.summary).toContain('# Haruspex model feedback');
		expect(mocks.invoke.mock.calls[1][1]).toEqual({ path: '/home/me/Downloads' });
		const url = new URL((mocks.invoke.mock.calls[3][1] as { url: string }).url);
		const body = url.searchParams.get('what-happened') ?? '';
		expect(body).toContain('Attach haruspex-model-feedback-2026-10-26.zip below');
		expect(body).not.toContain('GitHub API');
	});
});
