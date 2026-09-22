import { describe, it, expect } from 'vitest';
import { renderAssetReport, type ReportInput } from './report';
import type { AssetSpec } from '$lib/assets/spec/types';
import type { CheckReport } from '$lib/ipc/gen/CheckReport';
import type { AnchorOutcome, EntryOutcome } from './types';

function spec(): AssetSpec {
	return {
		version: 1,
		style: { prompt: 'flat pixel art' },
		anchor: { image: 'a/anchor.png', recipe: 'a/anchor.json' },
		normalize: { target_size: 32 },
		entries: [
			{ id: 'sword', kind: 'sprite', prompt: 'a sword', out: 'a/sword.png' },
			{ id: 'stone', kind: 'texture', prompt: 'cobblestone', out: 'a/stone.png' },
			{ id: 'coin', kind: 'icon', prompt: 'a coin', out: 'a/coin.png' }
		]
	} as unknown as AssetSpec;
}

function outcome(over: Partial<EntryOutcome> = {}): EntryOutcome {
	return {
		id: 'sword',
		status: 'done',
		attempts: 1,
		seed: 42,
		durationMs: 1500,
		degraded: [],
		...over
	};
}

function anchor(over: Partial<AnchorOutcome> = {}): AnchorOutcome {
	return {
		source: 'generated',
		approval: 'approved',
		attempts: 1,
		paletteSize: 16,
		imagePath: 'a/anchor.png',
		recipePath: 'a/anchor.json',
		...over
	};
}

function input(over: Partial<ReportInput> = {}): ReportInput {
	return {
		spec: spec(),
		specPath: 'a/spec.json',
		anchor: anchor(),
		entries: [outcome()],
		reports: new Map<string, CheckReport | null>(),
		contactSheet: 'a/contact-sheet.png',
		judgeSkipped: false,
		licensing: { modelName: 'SD 1.5', modelLicense: 'OpenRAIL-M.', loras: [] },
		startedAt: 0,
		finishedAt: 60_000,
		...over
	};
}

describe('the totals line', () => {
	it('counts every status', () => {
		const md = renderAssetReport(
			input({
				entries: [
					outcome({ id: 'sword' }),
					outcome({ id: 'stone', status: 'skipped' }),
					outcome({ id: 'coin', status: 'unresolved', reason: 'came back blank' })
				]
			})
		);
		expect(md).toContain('**1 generated**');
		expect(md).toContain('1 already present');
		expect(md).toContain('1 unresolved');
	});

	it('states the wall-clock cost of the run', () => {
		expect(renderAssetReport(input())).toContain('60.0s total');
	});
});

describe('the contact sheet', () => {
	it('is embedded when one was made', () => {
		expect(renderAssetReport(input())).toContain('![Contact sheet](a/contact-sheet.png)');
	});

	it('leaves the section out entirely when there was nothing to tile', () => {
		const md = renderAssetReport(input({ contactSheet: null }));
		expect(md).not.toContain('Contact sheet');
	});
});

describe('the anchor provenance line', () => {
	it('is rendered from the structure, not scraped from prose', () => {
		// Reused vs generated and approved vs auto-accepted are the two things
		// a reader needs; both come from AnchorOutcome fields.
		const reused = renderAssetReport(input({ anchor: anchor({ source: 'reused', attempts: 0 }) }));
		expect(reused).toContain('Reused the committed anchor');
		expect(reused).toContain('approved by a human');

		const auto = renderAssetReport(input({ anchor: anchor({ approval: 'auto' }) }));
		expect(auto).toContain('Generated in 1 attempt');
		expect(auto).toContain('nobody saw it');
	});

	it('says so plainly when there was no anchor', () => {
		expect(renderAssetReport(input({ anchor: null }))).toContain('No style anchor');
	});
});

describe('the asset table', () => {
	it('gives every entry a row with its seed, attempts and time', () => {
		const md = renderAssetReport(input({ entries: [outcome({ attempts: 3, seed: 77 })] }));
		const row = md.split('\n').find((l) => l.startsWith('| `sword`'))!;
		expect(row).toContain('sprite');
		expect(row).toContain('| 3 |');
		expect(row).toContain('| 77 |');
		expect(row).toContain('1.5s');
	});

	it('prints a dash rather than a zero for an entry that never generated', () => {
		// A seed of 0 is a real seed. Printing it for a skipped entry claims a
		// reproducibility that does not exist.
		const md = renderAssetReport(input({ entries: [outcome({ status: 'skipped', seed: null })] }));
		expect(md.split('\n').find((l) => l.startsWith('| `sword`'))).toContain('| — |');
	});
});

describe('the unresolved section', () => {
	it('names each failure, its reason, and the file that was NOT written', () => {
		// The rule that keeps a bad asset from being permanently skipped is
		// only trustworthy if the report says it was applied.
		const md = renderAssetReport(
			input({
				entries: [outcome({ id: 'coin', status: 'unresolved', attempts: 3, reason: 'flat mush' })]
			})
		);
		expect(md).toContain('## Not produced');
		expect(md).toContain('flat mush');
		expect(md).toContain('Nothing was written to `a/coin.png`');
	});

	it('says how close the closest attempt got', () => {
		const md = renderAssetReport(
			input({
				entries: [outcome({ id: 'coin', status: 'unresolved', reason: 'r' })],
				reports: new Map([
					[
						'coin',
						{
							passed: false,
							stats: { alpha: 0.9, entropy: 0.4, palette_distance: 0.02 },
							failed: ['entropy']
						} as CheckReport
					]
				])
			})
		);
		expect(md).toContain('Closest attempt still failed');
		expect(md).toContain('flat mush');
	});

	it('is absent when everything worked', () => {
		expect(renderAssetReport(input())).not.toContain('## Not produced');
	});
});

describe('the degraded section', () => {
	it('names each missing layer once, with the assets it cost', () => {
		// Forty identical lines is how a reader stops reading the report.
		const md = renderAssetReport(
			input({
				entries: [
					outcome({ id: 'sword', degraded: ['no reference conditioning'] }),
					outcome({ id: 'stone', degraded: ['no reference conditioning', 'not seamless'] })
				]
			})
		);
		// The table still carries a per-row column; the summary is what must
		// not repeat itself.
		const summary = md.slice(md.indexOf('## Degraded'));
		expect(summary.split('no reference conditioning').length - 1).toBe(1);
		expect(summary).toContain('`sword`, `stone`');
		expect(summary).toContain('not seamless');
	});

	it('is absent when nothing was degraded', () => {
		expect(renderAssetReport(input())).not.toContain('## Degraded');
	});
});

describe('the skipped judge', () => {
	it('is mentioned once, not once per entry', () => {
		const md = renderAssetReport(
			input({
				judgeSkipped: true,
				entries: [outcome({ id: 'sword' }), outcome({ id: 'stone' }), outcome({ id: 'coin' })]
			})
		);
		expect(md.split('does not accept').length - 1).toBe(1);
	});

	it('is not mentioned when the judge ran', () => {
		expect(renderAssetReport(input())).not.toContain('does not accept');
	});
});

describe('the licensing section', () => {
	it('is present even when everything is known, because absence reads as fine', () => {
		const md = renderAssetReport(input());
		expect(md).toContain('## Licensing');
		expect(md).toContain('OpenRAIL-M.');
	});

	it('says the licence is unknown for a checkpoint Haruspex did not provide', () => {
		// A hand-placed file, or whatever ComfyUI has configured. Saying
		// nothing would leave the reader assuming it is fine.
		const md = renderAssetReport(
			input({ licensing: { modelName: 'mystery.safetensors', modelLicense: null, loras: [] } })
		);
		expect(md).toContain('licence unknown');
		expect(md).toContain('mystery.safetensors');
	});

	it('flags every LoRA as unknown, separately from the base model', () => {
		// The finding this section exists for: a LoRA carries its own terms,
		// many published ones were trained on art their author did not own,
		// and a clean base-model licence must not be left standing for the
		// whole output.
		const md = renderAssetReport(
			input({
				licensing: {
					modelName: 'SD 1.5',
					modelLicense: 'OpenRAIL-M — commercial use allowed.',
					loras: ['pixel-art-xl', 'retro-rpg']
				}
			})
		);
		expect(md).toContain('pixel-art-xl');
		expect(md).toContain('retro-rpg');
		expect(md).toContain('licence unknown');
		expect(md).toContain('says nothing about these');
		// And the base model's licence is still stated, not replaced.
		expect(md).toContain('OpenRAIL-M');
	});

	it('says nothing about LoRAs when the spec named none', () => {
		expect(renderAssetReport(input())).not.toContain('A LoRA carries its own terms');
	});

	it('notes that the output is generally not copyrightable', () => {
		expect(renderAssetReport(input())).toContain('not copyrightable');
	});
});
