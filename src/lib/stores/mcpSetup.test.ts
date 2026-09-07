import { describe, it, expect, beforeEach } from 'vitest';
import type { SetupStep } from '$lib/ipc/gen/SetupStep';
import {
	clearSetupProgress,
	describeSetup,
	isSetupComplete,
	isStepSatisfied,
	resumeIndex,
	savedStepIndex,
	saveStepIndex,
	stepLabel,
	type SetupState
} from './mcpSetup';

const SERVER = 'srv-1';

const instruction: SetupStep = {
	kind: 'instruction',
	title: 'Create a project',
	text: 'Go and do it.',
	link: 'https://example.test'
};
const secret: SetupStep = {
	kind: 'secret',
	key: 'token',
	label: 'Token',
	help: null,
	optional: false
};
const file: SetupStep = {
	kind: 'file',
	label: 'Keys file',
	filename: 'gcp-oauth.keys.json',
	help: null,
	optional: false
};
const command: SetupStep = {
	kind: 'command',
	label: 'Sign in',
	args: [],
	help: null,
	optional: false
};
const addon: SetupStep = {
	kind: 'addon',
	label: 'Install the Godot plugin',
	url: 'https://example.test/addon.zip',
	sha256: 'a'.repeat(64),
	marker: 'project.godot',
	installPath: 'addons/godot_mcp',
	help: null,
	optional: false
};

function state(over: Partial<SetupState> = {}): SetupState {
	return { secrets: {}, filesPlaced: [], commandsRun: [], addonProjects: [], ...over };
}

beforeEach(() => {
	clearSetupProgress(SERVER);
});

describe('step satisfaction', () => {
	it('treats an instruction as done on sight', () => {
		expect(isStepSatisfied(instruction, state(), 0)).toBe(true);
	});

	it('needs a non-empty secret', () => {
		expect(isStepSatisfied(secret, state(), 0)).toBe(false);
		expect(isStepSatisfied(secret, state({ secrets: { token: 'ghp_x' } }), 0)).toBe(true);
	});

	it('treats a whitespace-only secret as empty', () => {
		// A token that is a single space installs cleanly and then fails
		// authentication with a message the user cannot connect to what they
		// typed.
		expect(isStepSatisfied(secret, state({ secrets: { token: '   ' } }), 0)).toBe(false);
	});

	it('needs the file to have actually been copied in', () => {
		expect(isStepSatisfied(file, state(), 0)).toBe(false);
		expect(isStepSatisfied(file, state({ filesPlaced: ['gcp-oauth.keys.json'] }), 0)).toBe(true);
	});

	it('needs the command to have been run, tracked by its position', () => {
		// Two command steps in one entry are distinguished by index, not label:
		// nothing stops a catalog from labelling both "Sign in".
		expect(isStepSatisfied(command, state({ commandsRun: [0] }), 1)).toBe(false);
		expect(isStepSatisfied(command, state({ commandsRun: [1] }), 1)).toBe(true);
	});

	it('needs the addon in at least one project', () => {
		// The step is repeatable — a user with three Godot projects installs it
		// three times — but one is enough to have finished setting up.
		expect(isStepSatisfied(addon, state(), 0)).toBe(false);
		expect(isStepSatisfied(addon, state({ addonProjects: ['/home/me/game'] }), 0)).toBe(true);
	});

	it('counts an undone optional step as satisfied, whatever its kind', () => {
		// Blender's Sketchfab key is the case: the help text says to leave it
		// blank, so a blank one must not disable Next. The same reasoning
		// applies to an optional file or command — nothing was done, and
		// nothing needed to be.
		expect(isStepSatisfied({ ...secret, optional: true }, state(), 0)).toBe(true);
		expect(isStepSatisfied({ ...file, optional: true }, state(), 0)).toBe(true);
		expect(isStepSatisfied({ ...command, optional: true }, state(), 0)).toBe(true);
	});
});

describe('resuming', () => {
	const steps = [instruction, secret, file];

	it('starts at the beginning with nothing saved', () => {
		expect(resumeIndex(steps, SERVER, state())).toBe(0);
	});

	it('returns to where the user left off', () => {
		saveStepIndex(SERVER, 2);
		const done = state({ secrets: { token: 'x' } });
		expect(resumeIndex(steps, SERVER, done)).toBe(2);
	});

	it('does not resume past a step that is no longer satisfied', () => {
		// A saved position can outrun the data — settings edited elsewhere, a
		// secret cleared — and letting the user "finish" past it would mark a
		// server startable while it is missing a credential.
		saveStepIndex(SERVER, 3);
		expect(resumeIndex(steps, SERVER, state())).toBe(1);
	});

	it('clamps a saved position beyond the end', () => {
		saveStepIndex(SERVER, 99);
		const done = state({ secrets: { token: 'x' }, filesPlaced: ['gcp-oauth.keys.json'] });
		expect(resumeIndex(steps, SERVER, done)).toBe(steps.length);
	});

	it('forgets progress once cleared', () => {
		saveStepIndex(SERVER, 2);
		expect(savedStepIndex(SERVER)).toBe(2);
		clearSetupProgress(SERVER);
		expect(savedStepIndex(SERVER)).toBe(0);
	});

	it('keeps one server’s progress separate from another’s', () => {
		saveStepIndex(SERVER, 2);
		saveStepIndex('srv-2', 1);
		clearSetupProgress(SERVER);
		expect(savedStepIndex('srv-2')).toBe(1);
		clearSetupProgress('srv-2');
	});
});

describe('completion', () => {
	it('is false while anything is outstanding', () => {
		expect(isSetupComplete([instruction, secret], state())).toBe(false);
	});

	it('is true with only optional steps left, as Blender’s entry ends', () => {
		// Blender finishes with two optional asset-service keys. Requiring
		// them would make its wizard impossible to finish as written.
		const blenderish = [instruction, { ...secret, optional: true }];
		expect(isSetupComplete(blenderish, state())).toBe(true);
	});

	it('is true once every step is satisfied', () => {
		expect(isSetupComplete([instruction, secret], state({ secrets: { token: 'x' } }))).toBe(true);
	});

	it('is trivially true for an entry with no setup at all', () => {
		expect(isSetupComplete([], state())).toBe(true);
	});
});

describe('disclosing the cost before installing', () => {
	it('says nothing for an entry that asks for nothing', () => {
		expect(describeSetup([])).toBeNull();
	});

	it('names a single credential', () => {
		expect(describeSetup([instruction, secret])).toBe('Setup asks for a credential.');
	});

	it('names the whole Google-shaped chain', () => {
		// The forcing case: finding this out *after* a download is when someone
		// abandons the integration half-configured.
		const described = describeSetup([instruction, instruction, file, secret, secret, command]);
		expect(described).toContain('2 credentials');
		expect(described).toContain('a file from your computer');
		expect(described).toContain('a one-time sign-in');
	});

	it('says a folder will be asked for when an addon is installed', () => {
		// Being told up front beats a directory picker appearing unannounced
		// halfway through setup.
		expect(describeSetup([instruction, addon])).toContain('a folder to add a plugin to');
	});

	it('still says something for an instructions-only entry', () => {
		expect(describeSetup([instruction, instruction])).toContain('2 setup steps');
	});
});

describe('step labels', () => {
	it('uses the title for an instruction and the label for the rest', () => {
		expect(stepLabel(instruction)).toBe('Create a project');
		expect(stepLabel(secret)).toBe('Token');
		expect(stepLabel(file)).toBe('Keys file');
		expect(stepLabel(command)).toBe('Sign in');
		expect(stepLabel(addon)).toBe('Install the Godot plugin');
	});
});
