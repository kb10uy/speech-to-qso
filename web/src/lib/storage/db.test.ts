import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import type { QsoRecord } from '../qso';
import { KeyValueStore, QsoStore, openDatabase } from './db';

let counter = 0;
async function stores() {
	const db = await openDatabase(`test-${++counter}`);
	return { qsos: new QsoStore(db), kv: new KeyValueStore(db) };
}

function record(id: string, createdAt: string, syncState: QsoRecord['syncState']): QsoRecord {
	return {
		id,
		callsign: 'JL1HIS',
		frequencyHz: 432_940_000,
		mode: 'FM',
		rstSent: '59',
		rstReceived: '59',
		qsl: 'none',
		timeOn: createdAt,
		operatorCall: 'JJ1ABC',
		location: '',
		createdAt,
		syncState,
		syncAttempts: 0
	};
}

describe('QsoStore', () => {
	it('lists QSOs newest first', async () => {
		const { qsos } = await stores();
		await qsos.put(record('a', '2026-10-03T01:00:00Z', 'synced'));
		await qsos.put(record('b', '2026-10-03T03:00:00Z', 'pending'));
		await qsos.put(record('c', '2026-10-03T02:00:00Z', 'failed'));
		expect((await qsos.list()).map((r) => r.id)).toEqual(['b', 'c', 'a']);
	});

	it('finds unsynced QSOs oldest first', async () => {
		const { qsos } = await stores();
		await qsos.put(record('a', '2026-10-03T01:00:00Z', 'synced'));
		await qsos.put(record('b', '2026-10-03T03:00:00Z', 'pending'));
		await qsos.put(record('c', '2026-10-03T02:00:00Z', 'failed'));
		expect((await qsos.unsynced()).map((r) => r.id)).toEqual(['c', 'b']);
	});

	it('updates and deletes', async () => {
		const { qsos } = await stores();
		await qsos.put(record('a', '2026-10-03T01:00:00Z', 'pending'));
		await qsos.put({ ...record('a', '2026-10-03T01:00:00Z', 'synced'), syncAttempts: 1 });
		expect((await qsos.get('a'))?.syncState).toBe('synced');
		await qsos.delete('a');
		expect(await qsos.list()).toEqual([]);
	});
});

describe('openDatabase', () => {
	it('upgrades the boolean QSL flag of version 1 to a status', async () => {
		const name = `test-${++counter}`;
		const legacy = (id: string, qslRequested: boolean) => {
			const { qsl: _qsl, ...rest } = record(id, '2026-10-03T01:00:00Z', 'synced');
			return { ...rest, qslRequested };
		};
		const v1 = await openDB(name, 1, {
			upgrade(db) {
				const qsos = db.createObjectStore('qsos', { keyPath: 'id' });
				qsos.createIndex('createdAt', 'createdAt');
				qsos.createIndex('syncState', 'syncState');
				db.createObjectStore('kv');
			}
		});
		await v1.put('qsos', legacy('a', true));
		await v1.put('qsos', legacy('b', false));
		await v1.put('kv', { rstSent: '59', rstReceived: '59', qslRequested: true }, 'draft');
		v1.close();

		const db = await openDatabase(name);
		const qsos = new QsoStore(db);
		expect((await qsos.get('a'))?.qsl).toBe('requested');
		expect((await qsos.get('b'))?.qsl).toBe('none');
		expect(await qsos.get('a')).not.toHaveProperty('qslRequested');
		expect(await new KeyValueStore(db).get('draft')).toEqual({
			rstSent: '59',
			rstReceived: '59',
			qsl: 'requested'
		});
	});
});

describe('KeyValueStore', () => {
	it('round-trips values', async () => {
		const { kv } = await stores();
		expect(await kv.get('session')).toBeUndefined();
		await kv.set('session', { operatorCall: 'JJ1ABC', frequencyAnchorHz: 433_000_000 });
		expect(await kv.get('session')).toEqual({
			operatorCall: 'JJ1ABC',
			frequencyAnchorHz: 433_000_000
		});
	});
});
