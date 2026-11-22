import { describe, expect, it } from 'vitest';
import {
	emailResearchConfigJson,
	emailResearchProblem,
	parseEmailResearchConfig,
	type ConfigContext,
	type EmailResearchConfig
} from './config';
import { accountTakenBy } from './accountJobs.svelte';

const good: EmailResearchConfig = {
	accountId: 'me',
	phrase: 'ask haruspex',
	dailyLimit: 10,
	pickup: 'arrival'
};

function ctx(over: Partial<ConfigContext> = {}): ConfigContext {
	return {
		workingDir: '',
		accountTakenBy: () => null,
		canSend: () => true,
		...over
	};
}

describe('email research config', () => {
	it('round-trips, keeps a null limit, and defaults what is malformed', () => {
		const json = emailResearchConfigJson({ ...good, phrase: '  ask haruspex ', dailyLimit: null });
		expect(parseEmailResearchConfig(json)).toEqual({ ...good, dailyLimit: null });
		expect(parseEmailResearchConfig('{"dailyLimit":"x","phrase":3}')).toEqual({
			accountId: '',
			phrase: '',
			dailyLimit: 10,
			pickup: 'schedule'
		});
		expect(parseEmailResearchConfig('not json').dailyLimit).toBe(10);
	});

	it('picks up on arrival for a new job, and keeps an older job on its schedule', () => {
		expect(parseEmailResearchConfig(null).pickup).toBe('arrival');
		const json = emailResearchConfigJson({ ...good, pickup: 'schedule' });
		expect(parseEmailResearchConfig(json).pickup).toBe('schedule');
		// Saved before the field existed.
		expect(parseEmailResearchConfig('{"accountId":"me","phrase":"ask haruspex"}').pickup).toBe(
			'schedule'
		);
		expect(parseEmailResearchConfig('not json').pickup).toBe('schedule');
	});

	it('accepts a good config', () => {
		expect(emailResearchProblem(good, ctx())).toBeNull();
		expect(emailResearchProblem({ ...good, dailyLimit: null }, ctx())).toBeNull();
	});

	it('refuses a missing or unsendable account, and a bad phrase or limit', () => {
		expect(emailResearchProblem({ ...good, accountId: '' }, ctx())).toMatch(/account/);
		expect(emailResearchProblem(good, ctx({ canSend: () => false }))).toMatch(/Allow sending/);
		expect(emailResearchProblem({ ...good, phrase: '  ' }, ctx())).toMatch(/phrase/);
		expect(emailResearchProblem({ ...good, phrase: 'ab' }, ctx())).toMatch(/3 to 60/);
		expect(emailResearchProblem({ ...good, phrase: 'x'.repeat(61) }, ctx())).toMatch(/3 to 60/);
		expect(emailResearchProblem({ ...good, phrase: 'ask\nharuspex' }, ctx())).toMatch(/one line/);
		expect(emailResearchProblem({ ...good, dailyLimit: 0 }, ctx())).toMatch(/daily limit/);
		expect(emailResearchProblem({ ...good, dailyLimit: 101 }, ctx())).toMatch(/daily limit/);
		expect(emailResearchProblem({ ...good, dailyLimit: 2.5 }, ctx())).toMatch(/daily limit/);
	});

	it('refuses a working directory', () => {
		expect(emailResearchProblem(good, ctx({ workingDir: '/home/me' }))).toMatch(
			/no working directory/
		);
	});

	it('refuses a second job on the same account, but not the job itself', () => {
		const jobs = { 4: 'me', 9: 'other' };
		const taken = (id: string, except?: number) => accountTakenBy(id, except, jobs);
		expect(emailResearchProblem(good, ctx({ accountTakenBy: taken }))).toBe(
			'This account already has a Research by email job.'
		);
		expect(emailResearchProblem(good, ctx({ jobId: 4, accountTakenBy: taken }))).toBeNull();
		expect(
			emailResearchProblem({ ...good, accountId: 'free' }, ctx({ accountTakenBy: taken }))
		).toBeNull();
	});

	it('names the lowest-numbered other job on an account', () => {
		expect(accountTakenBy('me', undefined, { 7: 'me', 3: 'me' })).toBe(3);
		expect(accountTakenBy('me', 3, { 7: 'me', 3: 'me' })).toBe(7);
		expect(accountTakenBy('me', 3, { 3: 'me' })).toBeNull();
	});
});
