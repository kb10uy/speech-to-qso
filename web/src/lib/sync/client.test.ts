import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../account/api';
import type { QsoApiPayload, QsoRecord } from '../qso';
import { syncAll, type QsoSender, type SyncTarget } from './client';

function record(id: string): QsoRecord {
	return {
		id,
		callsign: 'JL1HIS',
		frequencyHz: 432_940_000,
		mode: 'FM',
		rstSent: '59',
		rstReceived: '57',
		qsl: 'requested',
		timeOn: '2026-10-03T04:00:00.000Z',
		operatorCall: 'JJ1ABC',
		location: 'Minato',
		stationId: 'station-1',
		createdAt: `2026-10-03T04:00:0${id}.000Z`,
		syncState: 'pending',
		syncAttempts: 0
	};
}

class MemoryTarget implements SyncTarget {
	records = new Map<string, QsoRecord>();
	constructor(list: QsoRecord[]) {
		for (const r of list) this.records.set(r.id, r);
	}
	async unsynced() {
		return [...this.records.values()].filter((r) => r.syncState !== 'synced');
	}
	async put(r: QsoRecord) {
		this.records.set(r.id, r);
	}
}

function sender(answer: (payload: QsoApiPayload) => void) {
	const postQso = vi.fn(async (payload: QsoApiPayload) => {
		answer(payload);
		return { status: 'created' as const, id: payload.id, forwarded: true };
	});
	return { postQso } satisfies QsoSender;
}

describe('syncAll', () => {
	const now = () => new Date('2026-10-03T05:00:00Z');

	it('sends the API payload', async () => {
		const target = new MemoryTarget([record('1')]);
		const s = sender(() => {});
		await syncAll(target, s, now);
		expect(s.postQso).toHaveBeenCalledWith(
			expect.objectContaining({ id: '1', call: 'JL1HIS', rst_rcvd: '57', station_id: 'station-1' })
		);
	});

	it('marks records as synced or failed', async () => {
		const target = new MemoryTarget([record('1'), record('2')]);
		const s = sender(({ id }) => {
			if (id === '2') throw new ApiError('HTTP 422: bad', 422);
		});
		const report = await syncAll(target, s, now);
		expect(report).toEqual({ synced: 1, failed: 1, unauthorized: false });
		expect(target.records.get('1')).toMatchObject({
			syncState: 'synced',
			syncAttempts: 1,
			syncedAt: '2026-10-03T05:00:00.000Z'
		});
		expect(target.records.get('2')).toMatchObject({
			syncState: 'failed',
			syncAttempts: 1,
			syncError: 'HTTP 422: bad'
		});
	});

	it('stops at the first network error', async () => {
		const target = new MemoryTarget([record('1'), record('2')]);
		const s = sender(() => {
			throw new ApiError('network error: Failed to fetch', 0);
		});
		const report = await syncAll(target, s, now);
		expect(report).toEqual({ synced: 0, failed: 1, unauthorized: false });
		expect(s.postQso).toHaveBeenCalledOnce();
		expect(target.records.get('2')?.syncState).toBe('pending');
	});

	it('leaves QSOs untouched when signed out', async () => {
		const target = new MemoryTarget([record('1'), record('2')]);
		const s = sender(() => {
			throw new ApiError('HTTP 401: not signed in', 401);
		});
		const report = await syncAll(target, s, now);
		expect(report).toEqual({ synced: 0, failed: 0, unauthorized: true });
		expect(target.records.get('1')).toEqual(record('1'));
	});

	it('stops between records when the account changes during an upload', async () => {
		const target = new MemoryTarget([record('1'), record('2')]);
		let sameAccount = true;
		const s = sender(() => {
			sameAccount = false;
		});
		const report = await syncAll(target, s, now, () => sameAccount);
		expect(report.synced).toBe(1);
		expect(s.postQso).toHaveBeenCalledOnce();
		expect(target.records.get('2')).toEqual(record('2'));
	});
});
