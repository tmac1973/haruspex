/**
 * Whether a failure is the server not starting the model (another model holds
 * the GPU, or the VRAM preflight refused it) rather than the request itself.
 * Running out of memory while making something is the request's: it fails as
 * one.
 *
 * The video-sequence job waits and sends the clip again; the image and video
 * routers try the next model, when the chat model named none.
 */
export function couldNotStart(message: string): boolean {
	return /starting the backend|not enough VRAM|failed to load the model/i.test(message);
}
