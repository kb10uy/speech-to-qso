import type { OperatingSession } from './session';

/** A station location as served by `GET /api/stations`. Mirrors `Station` in `server/src/stations.rs`. */
export interface Station {
	id: string;
	/** Wavelog station location id; `null` for stations entered by hand. */
	wavelog_id: number | null;
	name: string;
	callsign: string;
	gridsquare: string;
	city: string;
	state: string;
	cnty: string;
	pota: string;
	sota: string;
	wwff: string;
	iota: string;
	sig: string;
	sig_info: string;
	power: number | null;
	active: boolean;
}

export interface StationList {
	default_station_id: string | null;
	stations: Station[];
}

/** Fields of a station entered by hand (`POST /api/stations`). */
export type StationInput = Omit<Station, 'id' | 'wavelog_id' | 'active'>;

export function emptyStationInput(callsign = ''): StationInput {
	return {
		name: '',
		callsign,
		gridsquare: '',
		city: '',
		state: '',
		cnty: '',
		pota: '',
		sota: '',
		wwff: '',
		iota: '',
		sig: '',
		sig_info: '',
		power: null
	};
}

const orUndefined = (s: string) => (s.trim() === '' ? undefined : s.trim());

/**
 * Switches the session to a station: its values become the session's defaults for location,
 * POTA reference and own JCC/JCG, which can still be edited afterwards.
 */
export function applyStation(session: OperatingSession, station: Station): OperatingSession {
	const stationCallsign = orUndefined(station.callsign)?.toUpperCase();
	return {
		...session,
		stationId: station.id,
		stationCallsign:
			stationCallsign === session.operatorCall.trim().toUpperCase() ? undefined : stationCallsign,
		location: station.city.trim(),
		potaReference: orUndefined(station.pota)?.toUpperCase(),
		myJcx: orUndefined(station.cnty)
	};
}

/**
 * The station the session should use: the one chosen on this device if it still exists,
 * otherwise the user's default. `undefined` when the session needs no change.
 */
export function stationToApply(session: OperatingSession, list: StationList): Station | undefined {
	if (list.stations.some((s) => s.id === session.stationId)) return undefined;
	return list.stations.find((s) => s.id === list.default_station_id);
}

export function stationLabel(station: Station): string {
	const source = station.wavelog_id === null ? '' : ' (Wavelog)';
	return `${station.name} · ${station.callsign}${source}`;
}
