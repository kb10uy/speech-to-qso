import { describe, expect, it, vi } from 'vitest';
import type { QsoRecord } from '../qso';
import { postQso, qsoEndpoint, syncAll, SyncError, type SyncTarget } from './client';

function record(id: string): QsoRecord {
	return {
		id,
		callsign: 'JL1HIS',
		frequencyHz: 432_940_000,
		mode: 'FM',
		rstSent: '59',
		rstReceived: '57',
		qslRequested: true,
		timeOn: '2026-10-03T04:00:00.000Z',
		operatorCall: 'JJ1ABC',
		location: 'Minato',
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

const settings = { endpoint: 'https://qso.example.com/', token: 'secret' };

describe('qsoEndpoint', () => {
	it('joins the base URL', () => {
		expect(qsoEndpoint(settings)).toBe('https://qso.example.com/api/qso');
		expect(qsoEndpoint({ endpoint: 'https://x.example/base', token: '' })).toBe(
			'https://x.example/base/api/qso'
		);
	});
});

describe('postQso', () => {
	it('posts the API payload with a bearer token', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
		await postQso(record('1'), settings, fetchMock);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://qso.example.com/api/qso');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
		expect(JSON.parse(init.body as string)).toMatchObject({
			id: '1',
			call: 'JL1HIS',
			rst_rcvd: '57'
		});
	});

	it('classifies errors', async () => {
		const status = (code: number) => vi.fn(async () => new Response('nope', { status: code }));
		await expect(postQso(record('1'), settings, status(400))).rejects.toMatchObject({
			retryable: false,
			message: 'HTTP 400: nope'
		});
		await expect(postQso(record('1'), settings, status(503))).rejects.toMatchObject({
			retryable: true
		});
		const offline = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		await expect(postQso(record('1'), settings, offline)).rejects.toBeInstanceOf(SyncError);
	});
});

describe('syncAll', () => {
	const now = () => new Date('2026-10-03T05:00:00Z');

	it('does nothing without an endpoint', async () => {
		const target = new MemoryTarget([record('1')]);
		const fetchMock = vi.fn();
		expect(await syncAll(target, { endpoint: '', token: '' }, fetchMock)).toEqual({
			synced: 0,
			failed: 0
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('marks records as synced or failed', async () => {
		const target = new MemoryTarget([record('1'), record('2')]);
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const id = JSON.parse(init.body as string).id;
			return new Response(id === '1' ? null : 'bad', { status: id === '1' ? 201 : 422 });
		});
		const report = await syncAll(target, settings, fetchMock as unknown as typeof fetch, now);
		expect(report).toEqual({ synced: 1, failed: 1 });
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
		const fetchMock = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		const report = await syncAll(target, settings, fetchMock, now);
		expect(report).toEqual({ synced: 0, failed: 1 });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(target.records.get('2')?.syncState).toBe('pending');
	});
});
