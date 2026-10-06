import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
vi.mock('#lib/api.ts', () => ({ chatCompletion: api.chatCompletion }));
const descriptor = vi.hoisted(() => ({ resolveBackendDescriptor: vi.fn(() => ({ kind: 'x' })) }));
vi.mock('#lib/inference/descriptor.ts', () => descriptor);
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({}),
	getSamplingParams: () => ({}),
	getChatTemplateKwargs: () => ({})
}));

import { runSubAgent } from './_helpers';

beforeEach(() => {
	api.chatCompletion.mockReset().mockResolvedValue({ content: 'findings' });
	descriptor.resolveBackendDescriptor.mockClear();
});

describe('runSubAgent', () => {
	it("runs on the calling turn's model, not the global one", async () => {
		// A chain on compute:3000 summarised every page it researched on the
		// model Settings pointed at, on another machine.
		const backend = { baseUrl: 'http://compute:3000', modelId: 'job-model' };
		expect(await runSubAgent([], 100, undefined, backend as never)).toBe('findings');
		expect(api.chatCompletion.mock.calls[0][0].backend).toBe(backend);
		expect(descriptor.resolveBackendDescriptor).toHaveBeenCalledWith(backend);
	});

	it('uses Settings when the turn has no override (chat)', async () => {
		await runSubAgent([], 100);
		expect(api.chatCompletion.mock.calls[0][0].backend).toBeUndefined();
		expect(descriptor.resolveBackendDescriptor).toHaveBeenCalledWith(undefined);
	});
});
