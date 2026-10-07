import { describe, expect, it } from 'vitest';
import { askRepoTrust, getPendingRepoTrust, resolveRepoTrust } from './repoTrust.svelte';

describe('repo trust prompt', () => {
	it('shares one prompt per repo and answers in order', async () => {
		const a1 = askRepoTrust({ root: '/a', skills: 1, agentsMd: false });
		const a2 = askRepoTrust({ root: '/a', skills: 1, agentsMd: false });
		const b = askRepoTrust({ root: '/b', skills: 0, agentsMd: true });
		expect(a1).toBe(a2);
		expect(getPendingRepoTrust()?.root).toBe('/a');

		resolveRepoTrust(true);
		expect(await a1).toBe(true);
		expect(getPendingRepoTrust()?.root).toBe('/b');

		resolveRepoTrust(false);
		expect(await b).toBe(false);
		expect(getPendingRepoTrust()).toBeNull();
	});
});
