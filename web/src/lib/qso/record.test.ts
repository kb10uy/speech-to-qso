import { describe, expect, it } from 'vitest';
import { newDraft } from './draft';
import { finalizeDraft, toApiPayload } from './record';
import { defaultSession, type OperatingSession } from './session';

const now = new Date('2026-10-03T04:05:06Z');
const session: OperatingSession = {
	...defaultSession(),
	operatorCall: ' jj1abc ',
	location: '東京都港区',
	potaReference: 'jp-0001',
	stationId: '',
	stationCallsign: ' jj1abc/1 '
};

describe('finalizeDraft', () => {
	it('reports missing fields', () => {
		const result = finalizeDraft(newDraft(), { ...session, operatorCall: '' }, 'id', now);
		expect(result).toEqual({
			ok: false,
			problems: ['Callsign is missing', 'Frequency is missing']
		});
	});

	it('leaves an empty operator callsign to Wavelog', () => {
		const draft = { ...newDraft({ frequencyHz: 432_940_000 }), callsign: 'JL1HIS' };
		const result = finalizeDraft(draft, { ...session, operatorCall: ' ' }, 'id', now);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.operatorCall).toBeUndefined();
		expect(toApiPayload(result.record).operator).toBeUndefined();
	});

	it('rejects an operator callsign the server would refuse', () => {
		const draft = { ...newDraft({ frequencyHz: 432_940_000 }), callsign: 'JL1HIS' };
		const result = finalizeDraft(draft, { ...session, operatorCall: 'JJ1ABC/' }, 'id', now);
		expect(result).toEqual({
			ok: false,
			problems: ['"JJ1ABC/" is not a valid operator callsign (Session)']
		});
	});

	it('builds a pending record using session defaults', () => {
		const draft = { ...newDraft({ frequencyHz: 432_940_000 }), callsign: 'JL1HIS', jcx: '100101' };
		const result = finalizeDraft(draft, session, 'uuid-1', now);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record).toEqual({
			id: 'uuid-1',
			callsign: 'JL1HIS',
			frequencyHz: 432_940_000,
			mode: 'FM',
			rstSent: '59',
			rstReceived: '59',
			jcx: '100101',
			qsl: 'none',
			timeOn: now.toISOString(),
			operatorCall: 'JJ1ABC',
			location: '東京都港区',
			potaReference: 'JP-0001',
			myJcx: undefined,
			stationId: undefined,
			stationCallsign: 'JJ1ABC/1',
			createdAt: now.toISOString(),
			syncState: 'pending',
			syncAttempts: 0
		});
	});

	it('uses the time of logging as the QSO time, not the draft start time', () => {
		const draft = {
			...newDraft({ frequencyHz: 145_000_000, mode: 'SSB' }),
			callsign: 'JL1HIS',
			startedAt: '2026-10-03T03:59:00.000Z'
		};
		const result = finalizeDraft(draft, session, 'id', now);
		expect(result.ok && result.record.timeOn).toBe(now.toISOString());
		expect(result.ok && result.record.mode).toBe('SSB');
	});
});

describe('toApiPayload', () => {
	it('matches the backend contract', () => {
		const draft = {
			...newDraft({ frequencyHz: 432_940_000 }),
			callsign: 'JL1HIS',
			rstReceived: '57',
			jcx: '100101',
			qsl: 'requested' as const
		};
		const result = finalizeDraft(draft, session, 'uuid-1', now);
		if (!result.ok) throw new Error('unexpected');
		expect(JSON.parse(JSON.stringify(toApiPayload(result.record)))).toEqual({
			id: 'uuid-1',
			call: 'JL1HIS',
			frequency: 432940000,
			mode: 'FM',
			rst_sent: '59',
			rst_rcvd: '57',
			jcx: '100101',
			qsl: 'requested',
			time_on: '2026-10-03T04:05:06.000Z',
			operator: 'JJ1ABC',
			location: '東京都港区',
			pota_ref: 'JP-0001',
			station_callsign: 'JJ1ABC/1'
		});
	});
});
