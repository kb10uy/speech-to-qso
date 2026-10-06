/** Formats a frequency in Hz as MHz with at least kHz precision, e.g. `432.940`. */
export function formatMhz(hz: number): string {
	const mhz = (hz / 1_000_000).toFixed(6);
	return mhz.replace(/(\.\d{3}\d*?)0+$/, '$1');
}

/** Formats an ISO 8601 time as UTC to the minute, e.g. `2026-10-03 04:05Z`. */
export function formatUtcMinute(iso: string): string {
	const utc = new Date(iso).toISOString();
	return `${utc.slice(0, 10)} ${utc.slice(11, 16)}Z`;
}

/** Parses a user-entered MHz value (e.g. `433` or `432.94`) into Hz. */
export function parseMhz(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return undefined;
	const [integer, fraction = ''] = trimmed.split('.');
	const hz = Number(integer) * 1_000_000 + Number(fraction.padEnd(6, '0'));
	return hz > 0 ? hz : undefined;
}
