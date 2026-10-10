import { describe, it, expect, vi, afterEach } from 'vitest';
import { cancelSandboxRun, rerunSandboxStep, setSandboxRunControls } from './runControls.ts';

describe('sandbox run controls', () => {
	afterEach(() => setSandboxRunControls(null));

	it('reach whoever registered them', () => {
		const rerun = vi.fn();
		const cancel = vi.fn();
		setSandboxRunControls({ rerun, cancel });
		rerunSandboxStep('step-1');
		cancelSandboxRun();
		expect(rerun).toHaveBeenCalledWith('step-1');
		expect(cancel).toHaveBeenCalled();
	});

	it('do nothing before anyone has', () => {
		expect(() => (rerunSandboxStep('step-1'), cancelSandboxRun())).not.toThrow();
	});
});
