import { describe, expect, it } from 'vitest';
import { newDraft } from './draft';
import { finalizeDraft, toApiPayload } from './record';
import { defaultSession, type OperatingSession } from './session';

const now = new Date('2026-10-03T04:05:06Z');
const session: OperatingSession = {
	...defaultSession(),
	operatorCall: ' jj1abc ',
	location: '東京都港区',
	potaReference: 'ja-0001',
	stationProfileId: ''
};

describe('finalizeDraft', () => {
	it('reports missing fields', () => {
		const result = finalizeDraft(newDraft(), { ...session, operatorCall: '' }, 'id', now);
		expect(result).toEqual({
			ok: false,
			problems: [
				'Callsign is missing',
				'Frequency is missing',
				'Operator callsign is not set (Session)'
			]
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
			qslRequested: false,
			timeOn: now.toISOString(),
			operatorCall: 'JJ1ABC',
			location: '東京都港区',
			potaReference: 'JA-0001',
			myJcx: undefined,
			stationProfileId: undefined,
			createdAt: now.toISOString(),
			syncState: 'pending',
			syncAttempts: 0
		});
	});

	it('uses the draft start time as the QSO time', () => {
		const draft = {
			...newDraft({ frequencyHz: 145_000_000, mode: 'SSB' }),
			callsign: 'JL1HIS',
			startedAt: '2026-10-03T03:59:00.000Z'
		};
		const result = finalizeDraft(draft, session, 'id', now);
		expect(result.ok && result.record.timeOn).toBe('2026-10-03T03:59:00.000Z');
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
			qslRequested: true
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
			qsl_requested: true,
			time_on: '2026-10-03T04:05:06.000Z',
			operator: 'JJ1ABC',
			location: '東京都港区',
			pota_ref: 'JA-0001'
		});
	});
});
