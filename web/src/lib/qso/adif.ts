import { bandForFrequency } from './band';
import type { QsoRecord } from './record';

const PROGRAM_ID = 'speech-to-qso';

function field(name: string, value: string | undefined): string {
	if (value === undefined || value === '') return '';
	return `<${name}:${[...value].length}>${value} `;
}

/** Formats a frequency in Hz as an ADIF FREQ value (MHz). */
export function adifFrequency(hz: number): string {
	return (hz / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
}

/** Renders one QSO as an ADIF (ADI) record. Keep in sync with `server/src/adif.rs`. */
export function adifRecord(record: QsoRecord): string {
	const time = new Date(record.timeOn);
	const iso = time.toISOString();
	const date = iso.slice(0, 10).replaceAll('-', '');
	const timeOn = iso.slice(11, 19).replaceAll(':', '');
	const comment = record.jcx === undefined ? undefined : `JCX ${record.jcx}`;

	return (
		[
			field('CALL', record.callsign),
			field('QSO_DATE', date),
			field('TIME_ON', timeOn),
			field('FREQ', adifFrequency(record.frequencyHz)),
			field('BAND', bandForFrequency(record.frequencyHz)),
			field('MODE', record.mode),
			field('RST_SENT', record.rstSent),
			field('RST_RCVD', record.rstReceived),
			// Requested: we owe a card. One way: we send none and one is on its way to us.
			field('QSL_SENT', { none: undefined, requested: 'R', oneWay: 'N' }[record.qsl]),
			field('QSL_RCVD', record.qsl === 'oneWay' ? 'R' : undefined),
			field('COMMENT', comment),
			field('APP_SPEECHTOQSO_JCX', record.jcx),
			field('OPERATOR', record.operatorCall),
			field('STATION_CALLSIGN', record.operatorCall),
			field('MY_CITY', record.location),
			field('APP_SPEECHTOQSO_MY_JCX', record.myJcx),
			field('MY_SIG', record.potaReference === undefined ? undefined : 'POTA'),
			field('MY_SIG_INFO', record.potaReference),
			field('MY_POTA_REF', record.potaReference)
		].join('') + '<EOR>'
	);
}

/** Renders a complete ADIF file. */
export function adifFile(records: readonly QsoRecord[], now: Date = new Date()): string {
	const created = now.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', ' ');
	const header =
		`Exported by ${PROGRAM_ID}\n` +
		field('ADIF_VER', '3.1.4') +
		field('PROGRAMID', PROGRAM_ID) +
		field('CREATED_TIMESTAMP', created) +
		'<EOH>\n';
	return header + records.map((r) => adifRecord(r) + '\n').join('');
}
