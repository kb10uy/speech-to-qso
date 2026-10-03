import type { DraftQso } from './draft';
import type { OperatingSession } from './session';

export type SyncState = 'pending' | 'synced' | 'failed';

/** A logged QSO, as stored in IndexedDB and sent to the backend. */
export interface QsoRecord {
	/** Client-generated UUID; also used by the backend for de-duplication. */
	id: string;
	callsign: string;
	frequencyHz: number;
	mode: string;
	rstSent: string;
	rstReceived: string;
	jcx?: string;
	qslRequested: boolean;
	/** QSO start time (ISO 8601, UTC). */
	timeOn: string;

	operatorCall: string;
	location: string;
	potaReference?: string;
	myJcx?: string;
	stationProfileId?: string;

	createdAt: string;
	syncState: SyncState;
	syncAttempts: number;
	syncError?: string;
	syncedAt?: string;
}

export type FinalizeResult = { ok: true; record: QsoRecord } | { ok: false; problems: string[] };

const blankToUndefined = (s: string | undefined) =>
	s === undefined || s.trim() === '' ? undefined : s.trim();

/** Validates a draft and turns it into a record ready to be stored. */
export function finalizeDraft(
	draft: DraftQso,
	session: OperatingSession,
	id: string,
	now: Date = new Date()
): FinalizeResult {
	const problems: string[] = [];
	if (draft.callsign === undefined) problems.push('Callsign is missing');
	if (draft.frequencyHz === undefined) problems.push('Frequency is missing');
	const mode = draft.mode ?? blankToUndefined(session.defaultMode);
	if (mode === undefined) problems.push('Mode is missing');
	if (session.operatorCall.trim() === '') problems.push('Operator callsign is not set (Session)');
	if (problems.length > 0) return { ok: false, problems };

	return {
		ok: true,
		record: {
			id,
			callsign: draft.callsign!,
			frequencyHz: draft.frequencyHz!,
			mode: mode!,
			rstSent: draft.rstSent,
			rstReceived: draft.rstReceived,
			jcx: draft.jcx,
			qslRequested: draft.qslRequested,
			timeOn: draft.startedAt ?? now.toISOString(),
			operatorCall: session.operatorCall.trim().toUpperCase(),
			location: session.location.trim(),
			potaReference: blankToUndefined(session.potaReference)?.toUpperCase(),
			myJcx: blankToUndefined(session.myJcx),
			stationProfileId: blankToUndefined(session.stationProfileId),
			createdAt: now.toISOString(),
			syncState: 'pending',
			syncAttempts: 0
		}
	};
}

/** JSON body for `POST /api/qso` on the backend. */
export interface QsoApiPayload {
	id: string;
	call: string;
	frequency: number;
	mode: string;
	rst_sent: string;
	rst_rcvd: string;
	jcx?: string;
	qsl_requested: boolean;
	time_on: string;
	operator: string;
	location: string;
	pota_ref?: string;
	my_jcx?: string;
	station_profile_id?: string;
}

export function toApiPayload(record: QsoRecord): QsoApiPayload {
	return {
		id: record.id,
		call: record.callsign,
		frequency: record.frequencyHz,
		mode: record.mode,
		rst_sent: record.rstSent,
		rst_rcvd: record.rstReceived,
		jcx: record.jcx,
		qsl_requested: record.qslRequested,
		time_on: record.timeOn,
		operator: record.operatorCall,
		location: record.location,
		pota_ref: record.potaReference,
		my_jcx: record.myJcx,
		station_profile_id: record.stationProfileId
	};
}
