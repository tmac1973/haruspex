import { beforeAll, describe, expect, it } from 'vitest';
import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import { draftFromProposal, type ProposalArgs } from './proposal';

// The barrel transforms every job type's module graph; pay it once.
let listJobTypes: () => JobTypeDefinition[];
let getJobType: (id: string) => JobTypeDefinition | undefined;
beforeAll(async () => {
	({ listJobTypes, getJobType } = await import('#lib/agent/jobs/types/index.ts'));
}, 60_000);

function args(over: Partial<ProposalArgs> = {}): ProposalArgs {
	return { name: 'Job', workingDir: '/p', brief: '', steps: [], settings: {}, spec: null, ...over };
}

function fakeDef(over: Partial<JobTypeDefinition> = {}): JobTypeDefinition {
	return {
		id: 'research',
		label: 'Fake',
		description: '',
		hasPlannedSteps: true,
		Editor: (() => {}) as unknown as JobTypeDefinition['Editor'],
		configDefaults: () => ({ mode: 'a', count: 3, flag: true }),
		configFromJob: () => ({}),
		configToJson: () => null,
		planSteps: () => [],
		runPipeline: async () => {},
		propose: {
			settings: {
				mode: { help: 'm', values: ['a', 'b'] },
				count: { help: 'c' },
				flag: { help: 'f' }
			}
		},
		...over
	};
}

describe('draftFromProposal', () => {
	it('lays settings over the defaults and keeps the steps', () => {
		const r = draftFromProposal(
			fakeDef(),
			args({ settings: { mode: 'b', count: 5 }, steps: [' one ', '', 'two'] })
		);
		expect(r).toEqual({
			draft: {
				jobType: 'research',
				name: 'Job',
				workingDir: '/p',
				config: { mode: 'b', count: 5, flag: true },
				steps: [
					{ prompt: 'one', deep_research: false },
					{ prompt: 'two', deep_research: false }
				]
			}
		});
	});

	it('refuses an unknown setting and lists the real ones', () => {
		const r = draftFromProposal(fakeDef(), args({ settings: { schedule: 'daily' } }));
		expect('error' in r && r.error).toMatch(/schedule is not a setting/);
		expect('error' in r && r.error).toMatch(/- mode: m \(a, b\)/);
	});

	it('refuses a value of the wrong type or outside its values', () => {
		const wrongType = draftFromProposal(fakeDef(), args({ settings: { flag: 'yes' } }));
		expect('error' in wrongType && wrongType.error).toMatch(/flag takes a boolean/);
		const wrongValue = draftFromProposal(fakeDef(), args({ settings: { mode: 'c' } }));
		expect('error' in wrongValue && wrongValue.error).toMatch(/mode takes a, b/);
	});

	it('keeps the brief as the description when the type has no place for it', () => {
		const r = draftFromProposal(fakeDef(), args({ brief: ' what we settled ' }));
		expect('draft' in r && r.draft.description).toBe('what we settled');
	});

	it("passes the brief to the type's own place for it", () => {
		const def = fakeDef({
			propose: {
				settings: {},
				brief: (d, brief) => ({ ...d, config: { ...d.config, idea: brief } })
			}
		});
		const r = draftFromProposal(def, args({ brief: 'a game' }));
		expect('draft' in r && r.draft.config.idea).toBe('a game');
		expect('draft' in r && r.draft.description).toBeUndefined();
	});

	it("returns the type's own validation message", () => {
		const def = fakeDef({ validate: () => 'At least one step prompt is required.' });
		const r = draftFromProposal(def, args());
		expect(r).toEqual({ error: "The job isn't ready: At least one step prompt is required." });
	});

	it('needs a working folder when the type does', () => {
		const def = fakeDef({ workingDirPlaceholder: 'x' });
		const r = draftFromProposal(def, args({ workingDir: ' ' }));
		expect('error' in r && r.error).toMatch(/needs working_dir/);
	});

	it('carries a spec the type can read, and refuses one it cannot', () => {
		const def = fakeDef({
			propose: {
				settings: {},
				spec: { path: () => 'spec.json', problems: (t) => (t.includes('{') ? [] : ['not JSON']) }
			}
		});
		const good = draftFromProposal(def, args({ spec: '{}' }));
		expect('draft' in good && good.draft.spec).toBe('{}\n');
		const bad = draftFromProposal(def, args({ spec: 'nope' }));
		expect('error' in bad && bad.error).toMatch(/- not JSON/);
		const none = draftFromProposal(fakeDef(), args({ spec: '{}' }));
		expect('error' in none && none.error).toMatch(/doesn't read a spec/);
	});
});

describe('the job types', () => {
	it("name only settings their editor state has, with a default of the setting's type", () => {
		for (const def of listJobTypes()) {
			if (!def.propose) continue;
			const defaults = def.configDefaults();
			for (const [key, setting] of Object.entries(def.propose.settings)) {
				expect(defaults, `${def.id}.${key}`).toHaveProperty(key);
				expect(defaults[key], `${def.id}.${key}`).not.toBeNull();
				if (setting.values) expect(setting.values).toContain(defaults[key]);
			}
		}
	});

	it('draft a guided-planning job from the brief alone', () => {
		const r = draftFromProposal(
			getJobType('guided_planning')!,
			args({
				brief: 'A todo app. Decided: SvelteKit, no login.',
				settings: { verification: 'lite' }
			})
		);
		expect('draft' in r && r.draft.config.initial_description).toBe(
			'A todo app. Decided: SvelteKit, no login.'
		);
		expect('draft' in r && r.draft.config.verification).toBe('lite');
	});

	it('put an audit brief in its one prompt', () => {
		const r = draftFromProposal(getJobType('audit')!, args({ brief: 'Look for SQL injection.' }));
		expect('draft' in r && r.draft.steps).toEqual([
			{ prompt: 'Look for SQL injection.', deep_research: false }
		]);
	});

	it('refuse a research job with no steps', () => {
		const r = draftFromProposal(getJobType('research')!, args({ brief: 'Find out about X.' }));
		expect('error' in r && r.error).toMatch(/step prompt is required/);
	});

	it('refuse an asset spec the asset job cannot read', () => {
		const r = draftFromProposal(
			getJobType('asset_generation')!,
			args({ brief: 'tiles', spec: '{ not json' })
		);
		expect('error' in r && r.error).toMatch(/The spec can't be read/);
	});
});
