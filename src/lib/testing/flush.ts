/**
 * Wait one macrotask, so promises already settling and timers already due
 * have run: what tests mean by "let it settle". Not shipped: only test files
 * import this. A test waiting for something in particular uses `vi.waitFor`.
 */
export function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
