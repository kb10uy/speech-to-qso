import { isCallsign } from '../dsl';

/** Information about the whole operating session (shared by every QSO in it). */
export interface OperatingSession {
    /** Empty to leave the operator to Wavelog, which fills in the token owner's callsign. */
    operatorCall: string;
    // The fields below override the chosen station's values; empty ones are left to the station
    // (and, in Wavelog, to its station location).
    /** Free-form operating location (the portable operation site). */
    location: string;
    /** Partially spoken frequencies snap to the candidate nearest to this. */
    frequencyAnchorHz: number;
    /** Mode used for new QSOs unless overridden by `mode ...`. */
    defaultMode: string;
    potaReference?: string;
    /** Own JCC/JCG code at the operating location. */
    myJcx?: string;
    /** The station (`Station.id`) chosen on this device; the server's default is used if unset. */
    stationId?: string;
    /** Callsign of the station (e.g. a club station or a portable suffix). */
    stationCallsign?: string;
}

export function defaultSession(): OperatingSession {
    return {
        operatorCall: '',
        location: '',
        frequencyAnchorHz: 433_000_000,
        defaultMode: 'FM'
    };
}

/** Why the operator callsign cannot be used, or `undefined` if it is fine (or empty). */
export function operatorCallProblem(operatorCall: string): string | undefined {
    const call = operatorCall.trim();
    if (call !== '' && !isCallsign(call.toUpperCase()))
        return `"${call}" is not a valid operator callsign`;
    return undefined;
}

export function sessionProblems(session: OperatingSession): string[] {
    const problems: string[] = [];
    const operator = operatorCallProblem(session.operatorCall);
    if (operator !== undefined) problems.push(operator);
    if (!(session.frequencyAnchorHz > 0)) problems.push('Frequency anchor is not set');
    return problems;
}
