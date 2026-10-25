import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import YoutubeUploadDialog from './YoutubeUploadDialog.svelte';
import { askYoutubeUpload } from '#lib/stores/youtubeUploadApproval.svelte.ts';

const request = {
	render: 'ep010/renders/ep010.mp4',
	durationSecs: 723,
	sizeBytes: 400 * 1024 ** 2,
	thumbnail: null,
	thumbnailDataUrl: null,
	email: 'tim@example.com',
	title: 'Episode 12',
	description: 'About.',
	tags: ['games'],
	categoryId: '22'
};

describe('YoutubeUploadDialog', () => {
	it('starts private, waits for "made for kids", and returns the edits', async () => {
		render(YoutubeUploadDialog);
		const answer = askYoutubeUpload(request);
		expect(await screen.findByText('Upload to YouTube?')).toBeTruthy();
		expect((screen.getByLabelText('Private') as HTMLInputElement).checked).toBe(true);
		const upload = screen.getByText('Upload').closest('button') as HTMLButtonElement;
		expect(upload.disabled).toBe(true);
		await fireEvent.input(screen.getByDisplayValue('Episode 12'), {
			target: { value: 'Episode 12: Castles' }
		});
		await fireEvent.click(screen.getByLabelText('Unlisted'));
		await fireEvent.click(screen.getByLabelText('No'));
		expect(upload.disabled).toBe(false);
		await fireEvent.click(upload);
		expect(await answer).toEqual({
			kind: 'upload',
			meta: {
				title: 'Episode 12: Castles',
				description: 'About.',
				tags: ['games'],
				categoryId: '22',
				visibility: 'unlisted',
				madeForKids: false
			}
		});
	});

	it('Cancel sends nothing', async () => {
		render(YoutubeUploadDialog);
		const answer = askYoutubeUpload(request);
		await fireEvent.click(await screen.findByText('Cancel'));
		expect(await answer).toEqual({ kind: 'cancelled', reason: 'The user cancelled the upload.' });
	});
});
