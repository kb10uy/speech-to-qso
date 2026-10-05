import { describe, expect, it } from 'vitest';
import { defaultSession } from './session';
import { applyStation, emptyStationInput, stationToApply, type Station } from './station';

function station(id: string, fields: Partial<Station> = {}): Station {
	return { ...emptyStationInput('JJ1ABC'), id, wavelog_id: 1, name: id, active: false, ...fields };
}

describe('applyStation', () => {
	const session = {
		...defaultSession(),
		operatorCall: 'JJ1ABC',
		location: 'Old',
		potaReference: 'JP-9999',
		myJcx: '9999'
	};

	it('takes the defaults from the station', () => {
		const park = station('park', {
			callsign: 'jj1abc/1',
			city: ' Minato ',
			pota: 'jp-0001',
			cnty: '100101'
		});
		expect(applyStation(session, park)).toEqual({
			...session,
			stationId: 'park',
			stationCallsign: 'JJ1ABC/1',
			location: 'Minato',
			potaReference: 'JP-0001',
			myJcx: '100101'
		});
	});

	it('clears what the station does not have', () => {
		const result = applyStation(session, station('home'));
		expect(result.stationCallsign).toBeUndefined();
		expect(result.location).toBe('');
		expect(result.potaReference).toBeUndefined();
		expect(result.myJcx).toBeUndefined();
	});
});

describe('stationToApply', () => {
	const list = { default_station_id: 'b', stations: [station('a'), station('b')] };

	it('keeps a station chosen on this device', () => {
		expect(stationToApply({ ...defaultSession(), stationId: 'a' }, list)).toBeUndefined();
	});

	it('falls back to the default when nothing or a deleted station is chosen', () => {
		expect(stationToApply(defaultSession(), list)?.id).toBe('b');
		expect(stationToApply({ ...defaultSession(), stationId: 'gone' }, list)?.id).toBe('b');
		expect(stationToApply(defaultSession(), { ...list, default_station_id: null })).toBeUndefined();
	});
});
