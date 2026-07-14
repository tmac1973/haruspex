import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import MicButton from './MicButton.svelte';
import {
	cancelVoiceCapture,
	getVoiceCaptureStatus,
	startVoiceCapture,
	stopAndTranscribe
} from '$lib/audio/voiceCapture.svelte';

// The real capture module drives Tauri IPC; MicButton only needs the
// status getter and the start / stop / cancel actions.
vi.mock('$lib/audio/voiceCapture.svelte', () => ({
	cancelVoiceCapture: vi.fn(async () => {}),
	getVoiceCaptureStatus: vi.fn(() => 'idle'),
	startVoiceCapture: vi.fn(async () => {}),
	stopAndTranscribe: vi.fn(async () => 'hello world')
}));

// The component reads the status once through a $derived over the mocked
// getter, so each test sets the status BEFORE rendering.
function setStatus(status: 'idle' | 'recording' | 'processing' | 'downloading') {
	vi.mocked(getVoiceCaptureStatus).mockReturnValue(status);
}

beforeEach(() => {
	vi.clearAllMocks();
	setStatus('idle');
	vi.mocked(stopAndTranscribe).mockResolvedValue('hello world');
});

function renderMic(onTranscription = vi.fn()) {
	render(MicButton, { props: { onTranscription } });
	return { button: screen.getByRole('button'), onTranscription };
}

describe('MicButton keyboard operability', () => {
	it('Space keydown starts capture', async () => {
		const { button } = renderMic();
		await fireEvent.keyDown(button, { key: ' ' });
		expect(startVoiceCapture).toHaveBeenCalledTimes(1);
	});

	it('Enter keydown starts capture', async () => {
		const { button } = renderMic();
		await fireEvent.keyDown(button, { key: 'Enter' });
		expect(startVoiceCapture).toHaveBeenCalledTimes(1);
	});

	it('ignores key auto-repeat while held', async () => {
		const { button } = renderMic();
		await fireEvent.keyDown(button, { key: ' ', repeat: true });
		expect(startVoiceCapture).not.toHaveBeenCalled();
	});

	it('keyup stops, transcribes, and delivers the text', async () => {
		setStatus('recording');
		const { button, onTranscription } = renderMic();
		await fireEvent.keyUp(button, { key: ' ' });
		expect(stopAndTranscribe).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(onTranscription).toHaveBeenCalledWith('hello world'));
	});

	it('Escape while recording cancels without transcribing', async () => {
		setStatus('recording');
		const { button, onTranscription } = renderMic();
		await fireEvent.keyDown(button, { key: 'Escape' });
		expect(cancelVoiceCapture).toHaveBeenCalledTimes(1);
		expect(stopAndTranscribe).not.toHaveBeenCalled();
		expect(onTranscription).not.toHaveBeenCalled();
	});

	it('blur while recording cancels without transcribing', async () => {
		setStatus('recording');
		const { button } = renderMic();
		await fireEvent.blur(button);
		expect(cancelVoiceCapture).toHaveBeenCalledTimes(1);
		expect(stopAndTranscribe).not.toHaveBeenCalled();
	});

	it('exposes recording state via aria-pressed', () => {
		setStatus('recording');
		const { button } = renderMic();
		expect(button.getAttribute('aria-pressed')).toBe('true');
	});
});
