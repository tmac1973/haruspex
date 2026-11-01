import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '#lib/api.ts';
import type { DeferredFamily } from './types';
import { argumentsFit, deferredToolName } from './_deferredLoaded';

const schema = (parameters: Record<string, unknown>): ToolDefinition => ({
	type: 'function',
	function: { name: 'video_probe', description: '', parameters }
});

describe('deferredToolName', () => {
	const deferred: DeferredFamily[] = [
		{ id: 'video', line: 'video — …', schemas: [schema({ type: 'object' })] }
	];

	it('names the tool a call means', () => {
		expect(deferredToolName('video_probe', deferred)).toBe('video_probe');
		expect(deferredToolName('video-probe', deferred)).toBe('video_probe');
	});

	it('names nothing for a tool the turn does not defer', () => {
		expect(deferredToolName('video-cut', deferred)).toBeUndefined();
		expect(deferredToolName('web_search', deferred)).toBeUndefined();
		expect(deferredToolName('video_probe', undefined)).toBeUndefined();
	});
});

describe('argumentsFit', () => {
	const probe = schema({
		type: 'object',
		properties: {
			episode: { type: 'string' },
			limit: { type: 'integer' },
			mode: { type: 'string', enum: ['fast', 'full'] },
			items: { type: 'array' }
		},
		required: ['episode']
	});

	it('accepts arguments that fit', () => {
		expect(argumentsFit(probe, { episode: 'ep012' })).toBe(true);
		expect(argumentsFit(probe, { episode: 'ep012', limit: 3, mode: 'fast', items: [] })).toBe(true);
	});

	it('refuses a missing required parameter, an unknown one, or a wrong type or value', () => {
		expect(argumentsFit(probe, {})).toBe(false);
		expect(argumentsFit(probe, { episode: 'ep012', clip: 'a.mp4' })).toBe(false);
		expect(argumentsFit(probe, { episode: 12 })).toBe(false);
		expect(argumentsFit(probe, { episode: 'ep012', limit: 1.5 })).toBe(false);
		expect(argumentsFit(probe, { episode: 'ep012', mode: 'slow' })).toBe(false);
	});

	it('refuses without a schema', () => {
		expect(argumentsFit(undefined, { episode: 'ep012' })).toBe(false);
	});
});
