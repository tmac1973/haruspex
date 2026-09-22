import { describe, it, expect } from 'vitest';
import { applyFieldMap, validateFieldMap, type ComfyGraph, type FieldMap } from './fieldMap';
import type { ImageRequest } from '../types';

function graph(): ComfyGraph {
	return {
		'1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'old.safetensors' } },
		'2': {
			class_type: 'LoraLoader',
			inputs: { lora_name: 'shipped', strength_model: 0.9, strength_clip: 0.9 }
		},
		'3': {
			class_type: 'LoraLoader',
			inputs: { lora_name: 'shipped2', strength_model: 0.9, strength_clip: 0.9 }
		},
		'4': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
		'6': { class_type: 'LoadImage', inputs: { image: '' } },
		'7': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, denoise: 1 } },
		'9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } }
	};
}

function map(): FieldMap {
	return {
		outputNode: '9',
		prompt: { kind: 'scalar', node: '4', input: 'text' },
		seed: { kind: 'scalar', node: '7', input: 'seed' },
		model: { kind: 'scalar', node: '1', input: 'ckpt_name' },
		referenceImage: { kind: 'uploaded', node: '6', input: 'image' },
		referenceStrength: { kind: 'scalar', node: '7', input: 'denoise' },
		loras: { kind: 'loraSlots', nodes: ['2', '3'] }
	};
}

const req = (over: Partial<ImageRequest> = {}): ImageRequest => ({
	prompt: 'a tin can',
	width: 512,
	height: 512,
	seed: 42,
	...over
});

describe('applyFieldMap', () => {
	it('substitutes scalars into the bound node inputs', () => {
		const out = applyFieldMap(graph(), map(), req());
		expect(out['4'].inputs.text).toBe('a tin can');
		expect(out['7'].inputs.seed).toBe(42);
	});

	it('never mutates the source graph', () => {
		// Templates are module constants and a run generates many images from
		// each one; a mutation would leak the first request into every later one.
		const g = graph();
		const before = JSON.stringify(g);
		applyFieldMap(g, map(), req());
		expect(JSON.stringify(g)).toBe(before);
	});

	it('leaves the template default in place for a value the request omits', () => {
		const out = applyFieldMap(graph(), map(), req({ referenceStrength: undefined }));
		expect(out['7'].inputs.denoise).toBe(1);
	});

	it('binds the uploaded FILENAME for a reference, never the bytes', () => {
		const out = applyFieldMap(graph(), map(), req({ referenceImage: new Uint8Array([1, 2, 3]) }), {
			referenceFilename: 'haruspex-ref.png'
		});
		expect(out['6'].inputs.image).toBe('haruspex-ref.png');
	});

	it('prefers a derived model over the one on the request', () => {
		// The derived value is the request's model already resolved against the
		// configured default, so it wins.
		const out = applyFieldMap(graph(), map(), req({ model: 'raw' }), { model: 'resolved' });
		expect(out['1'].inputs.ckpt_name).toBe('resolved');
	});

	it('fills LoRA slot 0 and ZEROES the unused slot', () => {
		// The zeroing is the point: a template that ships with two loaders must
		// not apply a leftover the caller never asked for.
		const out = applyFieldMap(graph(), map(), req({ loras: [{ name: 'pixel', strength: 0.8 }] }));
		expect(out['2'].inputs).toMatchObject({
			lora_name: 'pixel',
			strength_model: 0.8,
			strength_clip: 0.8
		});
		expect(out['3'].inputs.strength_model).toBe(0);
		expect(out['3'].inputs.strength_clip).toBe(0);
	});

	it('zeroes every slot when no LoRAs are requested', () => {
		const out = applyFieldMap(graph(), map(), req());
		expect(out['2'].inputs.strength_model).toBe(0);
		expect(out['3'].inputs.strength_model).toBe(0);
	});

	it('throws on a binding that names a node the graph does not have', () => {
		// Not a silent no-op. The alternative is a perfectly good picture made
		// with default parameters, which looks exactly like success.
		const bad = { ...map(), prompt: { kind: 'scalar' as const, node: '99', input: 'text' } };
		expect(() => applyFieldMap(graph(), bad, req())).toThrow(/node "99"/);
	});

	it('throws on a binding that names an input the node does not have', () => {
		const bad = { ...map(), prompt: { kind: 'scalar' as const, node: '4', input: 'nope' } };
		expect(() => applyFieldMap(graph(), bad, req())).toThrow(/"nope"/);
	});
});

describe('validateFieldMap', () => {
	it('accepts a map that matches its graph', () => {
		expect(validateFieldMap(graph(), map())).toEqual([]);
	});

	it('reports a missing output node', () => {
		expect(validateFieldMap(graph(), { ...map(), outputNode: '99' })[0]).toMatch(/output node/i);
	});

	it('reports a scalar binding pointing at nothing', () => {
		const bad = { ...map(), seed: { kind: 'scalar' as const, node: '7', input: 'missing' } };
		expect(validateFieldMap(graph(), bad).join(' ')).toMatch(/"missing"/);
	});

	it('reports a LoRA slot pointing at nothing', () => {
		const bad = { ...map(), loras: { kind: 'loraSlots' as const, nodes: ['2', '404'] } };
		expect(validateFieldMap(graph(), bad).join(' ')).toMatch(/"404"/);
	});

	it('reports a LoRA binding with no slots at all', () => {
		const bad = { ...map(), loras: { kind: 'loraSlots' as const, nodes: [] } };
		expect(validateFieldMap(graph(), bad).join(' ')).toMatch(/no slots/);
	});

	it('collects every problem rather than stopping at the first', () => {
		const bad: FieldMap = {
			outputNode: '99',
			prompt: { kind: 'scalar', node: '98', input: 'text' },
			seed: { kind: 'scalar', node: '7', input: 'nope' }
		};
		expect(validateFieldMap(graph(), bad)).toHaveLength(3);
	});
});
