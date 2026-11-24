import { describe, it, expect } from 'vitest';
import {
	canOpenSource,
	describeSource,
	parseJobRef,
	sourceFromToolContext,
	type SourceLookups
} from './source';

const lookups: SourceLookups = {
	conversationTitle: (id) => (id === 'c1' ? 'Speakers' : undefined),
	jobOfRun: async (runId) => (runId === 7 ? { jobId: 3, name: 'Update prices' } : null)
};

describe('describeSource', () => {
	it('names each kind', () => {
		expect(describeSource({ kind: 'user' })).toBe('Edited by you');
		expect(describeSource({ kind: 'chat', ref: 'c1', label: 'Speakers' })).toBe(
			'From Chat: Speakers'
		);
		expect(describeSource({ kind: 'shell' })).toBe('From Shell');
		expect(describeSource({ kind: 'job', ref: '3:7', label: 'Update prices' })).toBe(
			'From Jobs: Update prices'
		);
		expect(describeSource({ kind: 'import', label: 'prices.csv' })).toBe('From Import: prices.csv');
	});

	it('only links sources that lead somewhere', () => {
		expect(canOpenSource({ kind: 'chat', ref: 'c1' })).toBe(true);
		expect(canOpenSource({ kind: 'chat' })).toBe(false);
		expect(canOpenSource({ kind: 'shell', label: 'bash' })).toBe(false);
		expect(canOpenSource({ kind: 'user' })).toBe(false);
	});

	it('reads job refs', () => {
		expect(parseJobRef('3:7')).toEqual({ jobId: 3, runId: 7 });
		expect(parseJobRef('3')).toEqual({ jobId: 3, runId: null });
		expect(parseJobRef('x')).toBeNull();
	});
});

describe('sourceFromToolContext', () => {
	it('maps a chat turn to its conversation', async () => {
		expect(await sourceFromToolContext({ conversationId: 'c1' }, lookups)).toEqual({
			kind: 'chat',
			ref: 'c1',
			label: 'Speakers'
		});
	});

	it('maps a Code turn to its session, without the Code prefix', async () => {
		expect(
			await sourceFromToolContext(
				{ codeMode: true, codeSessionId: 's1', requester: () => 'Code · fix the bug' },
				lookups
			)
		).toEqual({ kind: 'code', ref: 's1', label: 'fix the bug' });
	});

	it('maps a Shell turn to the Shell tab', async () => {
		expect(
			await sourceFromToolContext({ shellMode: true, requester: () => 'bash' }, lookups)
		).toEqual({ kind: 'shell', label: 'bash' });
	});

	it('maps a job run to its job, before anything else', async () => {
		expect(await sourceFromToolContext({ jobRunId: 7, conversationId: 'c1' }, lookups)).toEqual({
			kind: 'job',
			ref: '3:7',
			label: 'Update prices'
		});
		expect(await sourceFromToolContext({ jobRunId: 99 }, lookups)).toEqual({ kind: 'job' });
	});

	it('maps a notebook chat turn to that notebook', async () => {
		expect(
			await sourceFromToolContext(
				{ conversationId: 'notebook-n1', notebookChat: { notebookId: 'n1', title: 'Speakers' } },
				lookups
			)
		).toEqual({ kind: 'notebook_chat', ref: 'notebook-n1', label: 'Speakers' });
	});
});
