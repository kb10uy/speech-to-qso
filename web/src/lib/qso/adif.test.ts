import { describe, expect, it } from 'vitest';
import { adifFile, adifFrequency, adifRecord } from './adif';
import { bandForFrequency } from './band';
import type { QsoRecord } from './record';
import { emptyStationInput, type Station } from './station';

const record: QsoRecord = {
    id: 'uuid-1',
    callsign: 'JL1HIS',
    frequencyHz: 432_940_000,
    mode: 'FM',
    rstSent: '59',
    rstReceived: '57',
    jcx: '100101',
    qsl: 'requested',
    timeOn: '2026-10-03T04:05:06.789Z',
    operatorCall: 'JJ1ABC',
    location: 'Minato',
    potaReference: 'JP-0001',
    createdAt: '2026-10-03T04:05:30.000Z',
    syncState: 'pending',
    syncAttempts: 0
};

describe('adifRecord', () => {
    it('renders an ADI record', () => {
        expect(adifRecord(record)).toBe(
            '<CALL:6>JL1HIS <QSO_DATE:8>20261003 <TIME_ON:6>040506 <FREQ:6>432.94 <BAND:4>70cm ' +
                '<MODE:2>FM <RST_SENT:2>59 <RST_RCVD:2>57 <QSL_SENT:1>R <CNTY:6>100101 ' +
                '<OPERATOR:6>JJ1ABC <STATION_CALLSIGN:6>JJ1ABC <MY_CITY:6>Minato <MY_SIG:4>POTA <MY_SIG_INFO:7>JP-0001 <MY_POTA_REF:7>JP-0001 <EOR>'
        );
    });

    it('renders a one-way card as nothing to send and a card to receive', () => {
        // Identical to the expectation in server/src/adif.rs.
        expect(adifRecord({ ...record, qsl: 'oneWay' as const })).toContain(
            '<RST_RCVD:2>57 <QSL_SENT:1>N <QSL_RCVD:1>R <CNTY:6>100101 '
        );
    });

    it('uses the station callsign when given', () => {
        // Identical to the expectation in server/src/adif.rs.
        expect(adifRecord({ ...record, stationCallsign: 'JJ1ABC/1' })).toContain(
            '<OPERATOR:6>JJ1ABC <STATION_CALLSIGN:8>JJ1ABC/1 '
        );
    });

    it('leaves the operator out when Wavelog fills it in', () => {
        // Identical to the expectation in server/src/adif.rs.
        expect(
            adifRecord({ ...record, operatorCall: undefined, stationCallsign: 'JJ1ABC/1' })
        ).toContain('<CNTY:6>100101 <STATION_CALLSIGN:8>JJ1ABC/1 <MY_CITY:6>');
    });

    it('renders the name and QTH after the JCX', () => {
        // Identical to the expectation in server/src/adif.rs.
        expect(adifRecord({ ...record, name: '太郎', qth: '東京都港区' })).toContain(
            '<CNTY:6>100101 <NAME:2>太郎 <QTH:5>東京都港区 <OPERATOR:6>JJ1ABC '
        );
    });

    it('fills in what the QSO left to its station', () => {
        const station: Station = {
            ...emptyStationInput('JJ1ABC/1'),
            id: 'park',
            wavelog_id: 1,
            city: 'Minato',
            cnty: '100101',
            pota: 'JP-0001',
            active: true
        };
        const bare = { ...record, operatorCall: undefined, location: '', potaReference: undefined };
        // Identical to the expectation in server/src/adif.rs.
        expect(adifRecord(bare, station)).toContain(
            '<STATION_CALLSIGN:8>JJ1ABC/1 <MY_CITY:6>Minato <MY_CNTY:6>100101 ' +
                '<MY_SIG:4>POTA <MY_SIG_INFO:7>JP-0001 <MY_POTA_REF:7>JP-0001 <EOR>'
        );
        // The QSO's own values win.
        expect(adifRecord({ ...bare, location: 'Shiba' }, station)).toContain('<MY_CITY:5>Shiba ');
    });

    it('omits empty optional fields', () => {
        const minimal = {
            ...record,
            jcx: undefined,
            qsl: 'none' as const,
            potaReference: undefined,
            location: ''
        };
        const adif = adifRecord(minimal);
        expect(adif).not.toMatch(/QSL_|CNTY|NAME|QTH|MY_SIG|MY_CITY/);
    });

    it('counts characters, not UTF-16 units', () => {
        expect(adifRecord({ ...record, location: '東京都港区' })).toContain(
            '<MY_CITY:5>東京都港区 '
        );
    });
});

describe('adifFile', () => {
    it('uses the default station for QSOs logged without one', () => {
        const station: Station = {
            ...emptyStationInput('JJ1ABC'),
            id: 'home',
            wavelog_id: null,
            city: 'Minato',
            active: false
        };
        const list = { default_station_id: 'home', stations: [station] };
        expect(adifFile([{ ...record, location: '' }], list)).toContain('<MY_CITY:6>Minato ');
    });

    it('adds a header', () => {
        const file = adifFile([record], undefined, new Date('2026-10-03T05:00:00Z'));
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
