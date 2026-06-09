import { describe, it, expect, vi } from 'vitest';
import { diagnoseEmptyResponse } from './diagnostics';
import type { SearchStep } from '$lib/agent/loop';

// The streamingContent branch logs via console.warn; keep test output quiet.
vi.spyOn(console, 'warn').mockImplementation(() => {});

function step(toolName: string, opts: Partial<SearchStep> = {}): SearchStep {
	return {
		id: 't',
		toolName,
		query: opts.query ?? 'q',
		status: opts.status ?? 'done',
		result: opts.result
	};
}

describe('diagnoseEmptyResponse', () => {
	it('commits a successful file write', () => {
		const steps = [step('fs_write_pdf', { query: 'report.pdf', result: 'Wrote: report.pdf' })];
		expect(diagnoseEmptyResponse(steps, '')).toEqual({
			type: 'commit',
			content: 'Done. File written: report.pdf'
		});
	});

	it('does not commit a failed file write whose result contains an error', () => {
		const steps = [step('fs_write_pdf', { query: 'r.pdf', result: '{"error":"disk full"}' })];
		expect(diagnoseEmptyResponse(steps, '').type).toBe('error');
	});

	it('reports a focused-request hint when email was listed but not summarized', () => {
		const d = diagnoseEmptyResponse([step('email_list_recent')], '');
		expect(d.type).toBe('error');
		expect(d).toMatchObject({ message: expect.stringContaining('Fetched your email listing') });
	});

	it('reports digest-incomplete when email was listed and summarized', () => {
		const steps = [step('email_list_recent'), step('email_summarize_message')];
		expect(diagnoseEmptyResponse(steps, '')).toMatchObject({
			message: expect.stringContaining('Email digest run completed')
		});
	});

	it('reports an image-stalled hint after an image search', () => {
		expect(diagnoseEmptyResponse([step('image_search')], '')).toMatchObject({
			message: expect.stringContaining('image-discovery')
		});
	});

	it('reports a research hint after web research', () => {
		expect(diagnoseEmptyResponse([step('web_search')], '')).toMatchObject({
			message: expect.stringContaining('Web research completed')
		});
	});

	it('reports a generic tools-ran hint for any other completed tool', () => {
		expect(diagnoseEmptyResponse([step('run_python')], '')).toMatchObject({
			message: expect.stringContaining('Tools ran but the model')
		});
	});

	it('reports a plain empty-response error when no tools ran', () => {
		expect(diagnoseEmptyResponse([], '')).toEqual({
			type: 'error',
			message: 'Model returned an empty response. Try rephrasing.'
		});
	});

	it('ignores still-running steps', () => {
		expect(diagnoseEmptyResponse([step('web_search', { status: 'running' })], '')).toEqual({
			type: 'error',
			message: 'Model returned an empty response. Try rephrasing.'
		});
	});
});
