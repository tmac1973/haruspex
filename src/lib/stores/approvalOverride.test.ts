import { describe, it, expect } from 'vitest';
import { isAutoApproveActive, runWithAutoApprove } from '$lib/stores/approvalOverride';

describe('approvalOverride', () => {
	it('is inactive by default', () => {
		expect(isAutoApproveActive()).toBe(false);
	});

	it('is active inside runWithAutoApprove and clears after', async () => {
		let observedInside = false;
		await runWithAutoApprove(async () => {
			observedInside = isAutoApproveActive();
		});
		expect(observedInside).toBe(true);
		expect(isAutoApproveActive()).toBe(false);
	});

	it('clears the flag even if the wrapped function throws', async () => {
		await expect(
			runWithAutoApprove(async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(isAutoApproveActive()).toBe(false);
	});

	it('rejects nested calls', async () => {
		await expect(
			runWithAutoApprove(async () => {
				await runWithAutoApprove(async () => {
					// unreachable
				});
			})
		).rejects.toThrow(/non-reentrant/);
		expect(isAutoApproveActive()).toBe(false);
	});

	it('propagates the wrapped function return value', async () => {
		const result = await runWithAutoApprove(async () => 'hello');
		expect(result).toBe('hello');
	});
});
