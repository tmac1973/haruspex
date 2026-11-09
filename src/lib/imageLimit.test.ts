import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatMessage } from '#lib/api.ts';
import {
	capImages,
	countImages,
	imageLimitFromError,
	imageLimitKey,
	knownImageLimit,
	omittedImageNote,
	rememberImageLimit,
	resetImageLimits
} from '#lib/imageLimit.ts';

const picture = (url: string) => ({ type: 'image_url' as const, image_url: { url } });

function pictures(...urls: string[]): ChatMessage {
	return { role: 'user', content: [{ type: 'text', text: 'Pictures:' }, ...urls.map(picture)] };
}

describe('imageLimitFromError', () => {
	it("reads vLLM's cap out of an OpenRouter error body", () => {
		// The body from #1053, escaped as OpenRouter nests it.
		const body =
			'{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"OpenAIException - At most 4 image(s) may be provided in one prompt. (parameter=image)\\"}}"}}}';
		expect(imageLimitFromError(`Server error: ${body}`)).toBe(4);
	});

	it('reads a cap of one', () => {
		expect(imageLimitFromError('At most 1 image(s) may be provided in one prompt.')).toBe(1);
	});

	it('is null for other errors', () => {
		expect(imageLimitFromError('n_ctx exceeded')).toBeNull();
	});
});

describe('capImages', () => {
	it('keeps the newest pictures and notes the dropped ones in place', () => {
		const messages: ChatMessage[] = [
			pictures('a', 'b'),
			{ role: 'assistant', content: 'ok' },
			pictures('c', 'd', 'e')
		];
		const capped = capImages(messages, 2);
		expect(countImages(capped)).toBe(2);
		expect(capped[0].content).toEqual([
			{ type: 'text', text: 'Pictures:' },
			{ type: 'text', text: omittedImageNote(2) },
			{ type: 'text', text: omittedImageNote(2) }
		]);
		expect(capped[1]).toBe(messages[1]);
		expect(capped[2].content).toEqual([
			{ type: 'text', text: 'Pictures:' },
			{ type: 'text', text: omittedImageNote(2) },
			picture('d'),
			picture('e')
		]);
		// The caller's thread is untouched.
		expect(countImages(messages)).toBe(5);
	});

	it('returns the same array when within the cap', () => {
		const messages = [pictures('a')];
		expect(capImages(messages, 4)).toBe(messages);
	});
});

describe('learned caps', () => {
	beforeEach(() => resetImageLimits());

	it('keeps the lowest cap seen for a server and model', () => {
		const key = imageLimitKey('https://example.test/v1/chat/completions', 'm');
		rememberImageLimit(key, 4);
		rememberImageLimit(key, 8);
		expect(knownImageLimit(key)).toBe(4);
		rememberImageLimit(key, 2);
		expect(knownImageLimit(key)).toBe(2);
		expect(knownImageLimit(imageLimitKey('https://example.test/v1/chat/completions', 'n'))).toBe(
			undefined
		);
	});
});
