import { describe, expect, it } from 'vitest';
import { defaultSession } from './session';
import {
	applyStation,
	emptyStationInput,
	stationDefaults,
	stationToApply,
	type Station
} from './station';

function station(id: string, fields: Partial<Station> = {}): Station {
	return { ...emptyStationInput('JJ1ABC'), id, wavelog_id: 1, name: id, active: false, ...fields };
}

describe('applyStation', () => {
	it('switches the station and drops the overrides made for the previous one', () => {
		const session = {
			...defaultSession(),
			operatorCall: 'JJ1ABC',
			stationId: 'home',
			stationCallsign: 'JJ1ABC/1',
			location: 'Old',
			potaReference: 'JP-9999',
			myJcx: '9999'
		};
		expect(applyStation(session, station('park'))).toEqual({
			...session,
			stationId: 'park',
			stationCallsign: undefined,
			location: '',
			potaReference: undefined,
			myJcx: undefined
		});
	});
});

describe('stationDefaults', () => {
	it('normalizes what the station has and leaves out the rest', () => {
		const park = station('park', { callsign: 'jj1abc/1', city: ' Minato ', pota: 'jp-0001' });
		expect(stationDefaults(park)).toEqual({
			stationCallsign: 'JJ1ABC/1',
			location: 'Minato',
			potaReference: 'JP-0001',
			myJcx: undefined
		});
		expect(stationDefaults(undefined)).toEqual({});
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
