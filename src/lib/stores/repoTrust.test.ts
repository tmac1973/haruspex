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

	it("keeps another computer's ask apart from this one's, and drops it when withdrawn", async () => {
		const here = askRepoTrust({ root: '/a', skills: 1, agentsMd: false });
		const ctrl = new AbortController();
		const there = askRepoTrust(
			{ root: '/a', skills: 1, agentsMd: false, origin: { peerId: 'desk', name: 'desk-pc' } },
			ctrl.signal
		);
		expect(there).not.toBe(here);
		ctrl.abort();
		expect(await there).toBe(false);
		expect(getPendingRepoTrust()?.origin).toBeUndefined();
		resolveRepoTrust(true);
		expect(await here).toBe(true);
		expect(getPendingRepoTrust()).toBeNull();
	});
});
