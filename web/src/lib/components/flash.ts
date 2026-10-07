import { tick } from 'svelte';

/**
 * Restarts a one-shot CSS animation class (`flash` or `flash-error` in app.css) once the pending
 * DOM update is done, which would otherwise rewrite the element's classes.
 */
export async function flash(
	element: () => Element | null | undefined,
	className: 'flash' | 'flash-error'
) {
	await tick();
	const target = element();
	if (!(target instanceof HTMLElement)) return;
	target.classList.remove(className);
	void target.offsetWidth;
	target.classList.add(className);
	target.addEventListener('animationend', () => target.classList.remove(className), {
		once: true
	});
}
