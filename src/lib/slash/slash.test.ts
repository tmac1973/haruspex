import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';

const mocks = vi.hoisted(() => ({
	list: [] as SkillSummary[],
	root: null as string | null,
	read: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === 'skills_list') return mocks.list;
		if (cmd === 'skills_project_root') return mocks.root;
		if (cmd === 'skill_read') return mocks.read();
		return null;
	})
}));

import { invoke } from '@tauri-apps/api/core';
import { defaultSkills, updateSkills } from '#lib/stores/settings.ts';
import {
	describeSkills,
	knownTrustedRoot,
	matchItems,
	parseSlash,
	resolveSlash,
	runSlash,
	slashItems,
	typingName
} from './slash';

function skill(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
	return {
		name,
		description: `${name} desc`,
		source: 'user',
		dir: `/skills/${name}`,
		license: null,
		compatibility: null,
		allowedTools: null,
		warnings: [],
		error: null,
		shadowed: false,
		createdByModel: false,
		...extra
	};
}

const doc = {
	name: 'deploy',
	body: 'Ship it.',
	dir: null,
	compatibility: null,
	files: [],
	filesTruncated: false
};

beforeEach(() => {
	vi.mocked(invoke).mockClear();
	mocks.list = [skill('deploy'), skill('docs'), skill('broken', { error: 'bad yaml' })];
	mocks.root = null;
	mocks.read.mockReset().mockResolvedValue(doc);
	updateSkills({ ...defaultSkills, trustedRepos: {} });
});

describe('parseSlash', () => {
	it('takes a name at the start, with or without a request', () => {
		expect(parseSlash('/deploy')).toEqual({ name: 'deploy', rest: '' });
		expect(parseSlash('/deploy to staging\nnow')).toEqual({
			name: 'deploy',
			rest: 'to staging\nnow'
		});
		expect(parseSlash('  /deploy x')).toEqual({ name: 'deploy', rest: 'x' });
	});

	it('ignores a slash anywhere else, and paths', () => {
		expect(parseSlash('please /deploy')).toBeNull();
		expect(parseSlash('/etc/hosts is broken')).toBeNull();
		expect(parseSlash('/')).toBeNull();
		expect(parseSlash('/ deploy')).toBeNull();
	});
});

describe('typingName', () => {
	it('is the name while it is still being typed', () => {
		expect(typingName('/')).toBe('');
		expect(typingName('/dep')).toBe('dep');
		expect(typingName('/deploy ')).toBeNull();
		expect(typingName('hello')).toBeNull();
		expect(typingName('/etc/')).toBeNull();
	});
});

describe('slashItems', () => {
	it('lists built-ins first, then usable skills, and a built-in name wins', async () => {
		mocks.list.push(skill('new'));
		const items = await slashItems(null);
		expect(items.map((i) => i.name)).toEqual(['new', 'skills', 'deploy', 'docs']);
		expect(matchItems(items, 'D').map((i) => i.name)).toEqual(['deploy', 'docs']);
	});
});

describe('resolveSlash', () => {
	it('finds a built-in, a skill, or nothing', async () => {
		expect(await resolveSlash('/new', null)).toEqual({ kind: 'builtin', name: 'new' });
		expect(await resolveSlash('/deploy now', null)).toEqual({ kind: 'skill', doc });
		expect(await resolveSlash('/nope now', null)).toEqual({ kind: 'none' });
		expect(await resolveSlash('/broken', null)).toEqual({ kind: 'none' });
		expect(await resolveSlash('hello', null)).toEqual({ kind: 'none' });
	});

	it("doesn't run a skill switched off in Settings", async () => {
		updateSkills({ disabled: ['deploy'] });
		expect(await resolveSlash('/deploy', null)).toEqual({ kind: 'none' });
	});

	it("throws when the skill can't be read, rather than send without it", async () => {
		mocks.read.mockRejectedValueOnce(new Error('gone'));
		await expect(resolveSlash('/deploy', null)).rejects.toThrow('gone');
	});
});

describe('/init, a built-in for Code mode', () => {
	beforeEach(() => {
		mocks.list.push(skill('init', { source: 'builtin', dir: null }));
	});

	it('is listed and run only in Code mode', async () => {
		expect((await slashItems(null)).map((i) => i.name)).not.toContain('init');
		expect((await slashItems(null, true)).map((i) => i.name)).toContain('init');
		expect(await resolveSlash('/init', null, true)).toEqual({ kind: 'skill', doc });
	});

	it('says it needs Code mode anywhere else, and sends nothing', async () => {
		expect(await resolveSlash('/init', null)).toEqual({ kind: 'needsCodeMode', name: 'init' });
		const addNote = vi.fn();
		const host = { projectRoot: async () => null, newConversation: vi.fn(), addNote };
		expect(await runSlash('/init', host)).toEqual({ kind: 'handled' });
		expect(addNote).toHaveBeenCalledWith(expect.stringContaining('needs Code mode'));
		const code = { ...host, codeMode: () => true };
		expect(await runSlash('/init', code)).toEqual({ kind: 'send', skill: doc });
	});

	it("doesn't hold back a user's own init skill", async () => {
		mocks.list = mocks.list.filter((s) => s.name !== 'init');
		mocks.list.push(skill('init'));
		expect((await slashItems(null)).map((i) => i.name)).toContain('init');
	});
});

describe('runSlash', () => {
	const host = () => ({
		projectRoot: vi.fn(async () => null),
		newConversation: vi.fn(),
		addNote: vi.fn()
	});

	it('runs the built-ins and sends nothing', async () => {
		const h = host();
		expect(await runSlash('/new', h)).toEqual({ kind: 'handled' });
		expect(h.newConversation).toHaveBeenCalledOnce();
		expect(await runSlash('/skills', h)).toEqual({ kind: 'handled' });
		expect(h.addNote).toHaveBeenCalledWith(expect.stringContaining('`/deploy`: deploy desc'));
	});

	it('sends a skill with the text, and anything else as written', async () => {
		const h = host();
		expect(await runSlash('/deploy now', h)).toEqual({ kind: 'send', skill: doc });
		expect(await runSlash('/etc/hosts is broken', h)).toEqual({ kind: 'send' });
		expect(await runSlash('hello', h)).toEqual({ kind: 'send' });
		// Only something that parses as a command looks for the repo.
		expect(h.projectRoot).toHaveBeenCalledTimes(1);
	});
});

describe('describeSkills', () => {
	it('points at Settings when there are none', () => {
		expect(describeSkills([])).toContain('Settings → Skills');
	});
});

describe('knownTrustedRoot', () => {
	it('gives a trusted repo, and never asks about one', async () => {
		mocks.root = '/code/repo';
		expect(await knownTrustedRoot('/code/repo/src')).toBeNull();
		updateSkills({ trustedRepos: { '/code/repo': { trusted: true } } });
		expect(await knownTrustedRoot('/code/repo/src')).toBe('/code/repo');
		expect(await knownTrustedRoot(null)).toBeNull();
	});
});
