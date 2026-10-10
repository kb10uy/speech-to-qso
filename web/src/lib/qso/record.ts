import type { QslStatus } from '../dsl';
import {
    EXCHANGE_STRING_MAX_LENGTH,
    contestProblems,
    defaultContest,
    exchangeString,
    expandExchange,
    type ContestSettings
} from './contest';
import { FREE_TEXT_MAX_LENGTH, type DraftQso } from './draft';
import { operatorCallProblem, sessionMode, type OperatingSession } from './session';

export type SyncState = 'pending' | 'synced' | 'failed';

/** A logged QSO, as stored in IndexedDB and sent to the backend. */
export interface QsoRecord {
    /** Client-generated UUID; also used by the backend for de-duplication. */
    id: string;
    callsign: string;
    frequencyHz: number;
    mode: string;
    submode?: string;
    rstSent: string;
    rstReceived: string;
    jcx?: string;
    qsl: QslStatus;
    name?: string;
    qth?: string;
    /** ADIF `CONTEST_ID`. */
    contestId?: string;
    /** ADIF `STX_STRING`: what we sent, with the RST if the contest settings say so. */
    exchangeSent?: string;
    /** ADIF `SRX_STRING`: what we received, with the RST if the contest settings say so. */
    exchangeReceived?: string;
    /** When the QSO was logged (ISO 8601, UTC). */
    timeOn: string;

    /** Missing when the session left it to Wavelog. */
    operatorCall?: string;
    location: string;
    potaReference?: string;
    myJcx?: string;
    stationId?: string;
    stationCallsign?: string;

    createdAt: string;
    syncState: SyncState;
    syncAttempts: number;
    syncError?: string;
    syncedAt?: string;
}

export type FinalizeResult = { ok: true; record: QsoRecord } | { ok: false; problems: string[] };

const blankToUndefined = (s: string | undefined) =>
    s === undefined || s.trim() === '' ? undefined : s.trim();

/**
 * Validates a draft and turns it into a record ready to be stored. In a contest, the sent number
 * uses `contest.nextSerial`; moving on to the next one is up to the caller.
 */
export function finalizeDraft(
    draft: DraftQso,
    session: OperatingSession,
    id: string,
    now: Date = new Date(),
    contest: ContestSettings = defaultContest()
): FinalizeResult {
    const problems: string[] = [];
    if (draft.callsign === undefined) problems.push('Callsign is missing');
    if (draft.frequencyHz === undefined) problems.push('Frequency is missing');
    const mode = draft.mode ?? sessionMode(session);
    if (mode === undefined) problems.push('Mode is missing');
    for (const [label, text] of [
        ['Name', draft.name],
        ['QTH', draft.qth]
    ] as const) {
        if (text !== undefined && [...text].length > FREE_TEXT_MAX_LENGTH)
            problems.push(`${label} is longer than ${FREE_TEXT_MAX_LENGTH} characters`);
    }
    const operator = operatorCallProblem(session.operatorCall);
    if (operator !== undefined) problems.push(`${operator} (Session)`);
    // A number spoken outside a contest is still worth keeping.
    const exchangeReceived = exchangeString(contest, draft.rstReceived, draft.exchangeReceived);
    let exchangeSent: string | undefined;
    if (contest.enabled) {
        if (draft.exchangeReceived === undefined) problems.push('Received number is missing');
        const contestSetup = contestProblems(contest);
        problems.push(...contestSetup.map((p) => `${p} (Contest)`));
        if (contestSetup.length === 0) {
            exchangeSent = exchangeString(
                contest,
                draft.rstSent,
                expandExchange(contest.exchangeTemplate, contest.nextSerial) || undefined
            );
            if (exchangeSent !== undefined && [...exchangeSent].length > EXCHANGE_STRING_MAX_LENGTH)
                problems.push(
                    `Sent number is longer than ${EXCHANGE_STRING_MAX_LENGTH} characters (Contest)`
                );
        }
    }
    if (problems.length > 0) return { ok: false, problems };

    return {
        ok: true,
        record: {
            id,
            callsign: draft.callsign!,
            frequencyHz: draft.frequencyHz!,
            mode: mode!.mode,
            submode: mode!.submode,
            rstSent: draft.rstSent,
            rstReceived: draft.rstReceived,
            jcx: draft.jcx,
            qsl: draft.qsl,
            name: draft.name,
            qth: draft.qth,
            contestId: contest.enabled
                ? blankToUndefined(contest.contestId)?.toUpperCase()
                : undefined,
            exchangeSent,
            exchangeReceived,
            timeOn: now.toISOString(),
            operatorCall: blankToUndefined(session.operatorCall)?.toUpperCase(),
            location: session.location.trim(),
            potaReference: blankToUndefined(session.potaReference)?.toUpperCase(),
            myJcx: blankToUndefined(session.myJcx),
            stationId: blankToUndefined(session.stationId),
            stationCallsign: blankToUndefined(session.stationCallsign)?.toUpperCase(),
            createdAt: now.toISOString(),
            syncState: 'pending',
            syncAttempts: 0
        }
    };
}

/** JSON body for `POST /api/qso`. Mirrors `QsoPayload` in `server/src/qso.rs`. */
export interface QsoApiPayload {
    id: string;
    call: string;
    frequency: number;
    mode: string;
    submode?: string;
    rst_sent: string;
    rst_rcvd: string;
    jcx?: string;
    qsl: QslStatus;
    name?: string;
    qth?: string;
    contest_id?: string;
    stx_string?: string;
    srx_string?: string;
    time_on: string;
    operator?: string;
    location: string;
    pota_ref?: string;
    my_jcx?: string;
    station_callsign?: string;
    station_id?: string;
}

export function toApiPayload(record: QsoRecord): QsoApiPayload {
    return {
        id: record.id,
        call: record.callsign,
        frequency: record.frequencyHz,
        mode: record.mode,
        submode: record.submode,
        rst_sent: record.rstSent,
        rst_rcvd: record.rstReceived,
        jcx: record.jcx,
        qsl: record.qsl,
        name: record.name,
        qth: record.qth,
        contest_id: record.contestId,
        stx_string: record.exchangeSent,
        srx_string: record.exchangeReceived,
        time_on: record.timeOn,
        operator: record.operatorCall,
        location: record.location,
        pota_ref: record.potaReference,
        my_jcx: record.myJcx,
        station_callsign: record.stationCallsign,
        station_id: record.stationId
    };
}
