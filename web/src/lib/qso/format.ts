/** Formats a frequency in Hz as MHz with at least kHz precision, e.g. `432.940`. */
export function formatMhz(hz: number): string {
	const mhz = (hz / 1_000_000).toFixed(6);
	return mhz.replace(/(\.\d{3}\d*?)0+$/, '$1');
}

/** Parses a user-entered MHz value (e.g. `433` or `432.94`) into Hz. */
export function parseMhz(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return undefined;
	const [integer, fraction = ''] = trimmed.split('.');
	const hz = Number(integer) * 1_000_000 + Number(fraction.padEnd(6, '0'));
	return hz > 0 ? hz : undefined;
}
