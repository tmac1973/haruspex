import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import CameraApprovalModal from './CameraApprovalModal.svelte';
import {
	askCameraUse,
	getPendingCameraUse,
	resolveCameraUse,
	type CameraAction
} from '#lib/stores/cameraApproval.svelte.ts';

afterEach(() => {
	while (getPendingCameraUse()) resolveCameraUse('deny');
});

describe('CameraApprovalModal', () => {
	it.each<[CameraAction, string]>([
		['look', 'Let the assistant look through Kitchen?'],
		['listen', 'Let the assistant listen on Kitchen?'],
		['move', 'Let the assistant move Kitchen?'],
		['save_preset', 'Let the assistant save a preset on Kitchen?'],
		['read_log', 'Let the assistant read the log of Kitchen?']
	])('asks to %s', async (action, question) => {
		render(CameraApprovalModal);
		void askCameraUse({ cameras: ['Kitchen'], action });
		await tick();
		screen.getByText(question);
	});

	it('names every camera asked about', async () => {
		render(CameraApprovalModal);
		void askCameraUse({ cameras: ['Kitchen', 'Porch', 'Garage'], action: 'read_log' });
		await tick();
		screen.getByText('Let the assistant read the log of Kitchen, Porch and Garage?');
	});

	it('answers with the button pressed', async () => {
		render(CameraApprovalModal);
		const allowed = askCameraUse({ cameras: ['Kitchen'], action: 'look' });
		await tick();
		await fireEvent.click(screen.getByText('Allow'));
		expect(await allowed).toBe('allow');

		const denied = askCameraUse({ cameras: ['Kitchen'], action: 'listen' });
		await tick();
		await fireEvent.click(screen.getByText('Deny'));
		expect(await denied).toBe('deny');
	});
});
