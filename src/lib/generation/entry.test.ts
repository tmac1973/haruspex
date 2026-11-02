import { describe, it, expect } from 'vitest';
import { entryConfigKey, uniqueName, type GenerationEntry } from './entry';

const entry = (
	over: Partial<GenerationEntry<string, null>> = {}
): GenerationEntry<string, null> => ({
	id: 'a',
	name: 'klein',
	backend: 'llama-toolchest',
	url: 'http://box:3000',
	keyId: null,
	model: 'klein',
	options: {},
	caps: null,
	capsAt: null,
	renamed: false,
	...over
});

describe('entryConfigKey', () => {
	it('changes with what a backend sends, not with the name or what a probe saw', () => {
		const key = entryConfigKey(entry());
		expect(entryConfigKey(entry({ name: 'other', capsAt: 5, renamed: true }))).toBe(key);
		expect(entryConfigKey(entry({ url: 'http://box:3000 ' }))).toBe(key);
		expect(entryConfigKey(entry({ model: 'ming' }))).not.toBe(key);
		expect(entryConfigKey(entry({ keyId: 'k1' }))).not.toBe(key);
		expect(entryConfigKey(entry({ options: { workflowPath: '/w.json' } }))).not.toBe(key);
	});

	it('ignores the order options were set in', () => {
		expect(entryConfigKey(entry({ options: { a: '1', b: '2' } }))).toBe(
			entryConfigKey(entry({ options: { b: '2', a: '1' } }))
		);
	});
});

describe('uniqueName', () => {
	it('keeps a free name, then adds the host, then a number', () => {
		expect(uniqueName('klein', 'asmodean', [])).toBe('klein');
		expect(uniqueName('klein', 'asmodean', ['klein'])).toBe('klein (asmodean)');
		expect(uniqueName('klein', 'asmodean', ['klein', 'klein (asmodean)'])).toBe('klein 2');
		expect(uniqueName('ComfyUI', '', ['ComfyUI', 'ComfyUI 2'])).toBe('ComfyUI 3');
	});
});
