import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import MicButton from './MicButton.svelte';
import {
	cancelVoiceCapture,
	getVoiceCaptureStatus,
	isListeningOwner,
	startListening,
	startVoiceCapture,
	stopAndTranscribe,
	stopListening
} from '#lib/audio/voiceCapture.svelte.ts';

// The real capture module drives Tauri IPC; MicButton only needs the
// status getter and the start / stop / cancel actions.
vi.mock('#lib/audio/voiceCapture.svelte.ts', () => ({
	cancelVoiceCapture: vi.fn(async () => {}),
	getVoiceCaptureStatus: vi.fn(() => 'idle'),
	startVoiceCapture: vi.fn(async () => {}),
	stopAndTranscribe: vi.fn(async () => 'hello world'),
	getPendingPhrases: vi.fn(() => 0),
	isListeningOwner: vi.fn(() => false),
	startListening: vi.fn(async () => {}),
	stopListening: vi.fn(async () => {})
}));

// The component reads the status once through a $derived over the mocked
// getter, so each test sets the status BEFORE rendering.
function setStatus(
	status: 'idle' | 'recording' | 'processing' | 'downloading' | 'listening' | 'paused'
) {
	vi.mocked(getVoiceCaptureStatus).mockReturnValue(status);
}

beforeEach(() => {
	vi.clearAllMocks();
	setStatus('idle');
	vi.mocked(stopAndTranscribe).mockResolvedValue('hello world');
	vi.mocked(isListeningOwner).mockReturnValue(false);
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

describe('MicButton constant listening', () => {
	const dictation = { getText: () => '', setText: () => {}, send: async () => true };

	it('offers no menu without a composer to dictate into', async () => {
		const { button } = renderMic();
		await fireEvent.contextMenu(button);
		expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
	});

	it('right-click → Constant listening starts it for this composer', async () => {
		render(MicButton, { props: { onTranscription: vi.fn(), dictation } });
		const button = screen.getByRole('button');
		await fireEvent.mouseDown(button, { button: 2 });
		expect(startVoiceCapture).not.toHaveBeenCalled();
		await fireEvent.contextMenu(button);
		await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Constant listening/ }));
		expect(startListening).toHaveBeenCalledWith(expect.any(Symbol), dictation);
	});

	it('a click while listening stops it instead of push-to-talk', async () => {
		setStatus('listening');
		vi.mocked(isListeningOwner).mockReturnValue(true);
		render(MicButton, { props: { onTranscription: vi.fn(), dictation, disabled: true } });
		const button = screen.getByRole('button');
		expect(button.getAttribute('aria-pressed')).toBe('true');
		expect((button as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.mouseDown(button, { button: 0 });
		expect(stopListening).toHaveBeenCalledTimes(1);
		expect(startVoiceCapture).not.toHaveBeenCalled();
	});

	it('switching conversation stops its listening', async () => {
		setStatus('listening');
		vi.mocked(isListeningOwner).mockReturnValue(true);
		const { rerender } = render(MicButton, {
			props: { onTranscription: vi.fn(), dictation, contextKey: 'a' }
		});
		expect(stopListening).not.toHaveBeenCalled();
		await rerender({ onTranscription: vi.fn(), dictation, contextKey: 'b' });
		await waitFor(() => expect(stopListening).toHaveBeenCalledTimes(1));
	});
});
