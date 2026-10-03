import { describe, expect, it } from 'vitest';
import { adifFile, adifFrequency, adifRecord } from './adif';
import { bandForFrequency } from './band';
import type { QsoRecord } from './record';

const record: QsoRecord = {
	id: 'uuid-1',
	callsign: 'JL1HIS',
	frequencyHz: 432_940_000,
	mode: 'FM',
	rstSent: '59',
	rstReceived: '57',
	jcx: '100101',
	qslRequested: true,
	timeOn: '2026-10-03T04:05:06.789Z',
	operatorCall: 'JJ1ABC',
	location: 'Minato',
	potaReference: 'JA-0001',
	createdAt: '2026-10-03T04:05:30.000Z',
	syncState: 'pending',
	syncAttempts: 0
};

describe('adifRecord', () => {
	it('renders an ADI record', () => {
		expect(adifRecord(record)).toBe(
			'<CALL:6>JL1HIS <QSO_DATE:8>20261003 <TIME_ON:6>040506 <FREQ:6>432.94 <BAND:4>70cm ' +
				'<MODE:2>FM <RST_SENT:2>59 <RST_RCVD:2>57 <QSL_SENT:1>R <COMMENT:10>JCX 100101 ' +
				'<APP_SPEECHTOQSO_JCX:6>100101 <OPERATOR:6>JJ1ABC <STATION_CALLSIGN:6>JJ1ABC ' +
				'<MY_CITY:6>Minato <MY_SIG:4>POTA <MY_SIG_INFO:7>JA-0001 <MY_POTA_REF:7>JA-0001 <EOR>'
		);
	});

	it('omits empty optional fields', () => {
		const minimal = {
			...record,
			jcx: undefined,
			qslRequested: false,
			potaReference: undefined,
			location: ''
		};
		const adif = adifRecord(minimal);
		expect(adif).not.toMatch(/QSL_SENT|COMMENT|JCX|MY_SIG|MY_CITY/);
	});

	it('counts characters, not UTF-16 units', () => {
		expect(adifRecord({ ...record, location: '東京都港区' })).toContain('<MY_CITY:5>東京都港区 ');
	});
});

describe('adifFile', () => {
	it('adds a header', () => {
		const file = adifFile([record], new Date('2026-10-03T05:00:00Z'));
		expect(file).toMatch(/^Exported by speech-to-qso\n<ADIF_VER:5>3\.1\.4 /);
		expect(file).toContain('<CREATED_TIMESTAMP:15>20261003 050000 <EOH>\n');
		expect(file.trimEnd().endsWith('<EOR>')).toBe(true);
	});
});

describe('adifFrequency', () => {
	it('trims trailing zeros', () => {
		expect(adifFrequency(432_940_000)).toBe('432.94');
		expect(adifFrequency(7_000_000)).toBe('7');
		expect(adifFrequency(7_123_456)).toBe('7.123456');
	});
});

describe('bandForFrequency', () => {
	it('finds amateur bands', () => {
		expect(bandForFrequency(432_940_000)).toBe('70cm');
		expect(bandForFrequency(145_500_000)).toBe('2m');
		expect(bandForFrequency(7_090_000)).toBe('40m');
		expect(bandForFrequency(1_294_000_000)).toBe('23cm');
		expect(bandForFrequency(100_000_000)).toBeUndefined();
	});
});
