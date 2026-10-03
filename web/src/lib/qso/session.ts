/** Information about the whole operating session (shared by every QSO in it). */
export interface OperatingSession {
	operatorCall: string;
	/** Free-form operating location (the portable operation site). */
	location: string;
	/** Partially spoken frequencies snap to the candidate nearest to this. */
	frequencyAnchorHz: number;
	/** Mode used for new QSOs unless overridden by `mode ...`. */
	defaultMode: string;
	potaReference?: string;
	/** Own JCC/JCG code at the operating location. */
	myJcx?: string;
	/** Wavelog station location (station profile) id; the backend default is used if empty. */
	stationProfileId?: string;
}

export function defaultSession(): OperatingSession {
	return {
		operatorCall: '',
		location: '',
		frequencyAnchorHz: 433_000_000,
		defaultMode: 'FM'
	};
}

export function sessionProblems(session: OperatingSession): string[] {
	const problems: string[] = [];
	if (session.operatorCall.trim() === '') problems.push('Operator callsign is not set');
	if (!(session.frequencyAnchorHz > 0)) problems.push('Frequency anchor is not set');
	return problems;
}
