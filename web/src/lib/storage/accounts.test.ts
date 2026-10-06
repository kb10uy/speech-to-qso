import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { defaultSession, finalizeDraft, newDraft } from '../qso';
import { DeviceStorage } from './accounts';

let counter = 0;
function record(id: string) {
	const result = finalizeDraft(
		{ ...newDraft({ frequencyHz: 432_940_000 }), callsign: 'JL1HIS' },
		defaultSession(),
		id
	);
	if (!result.ok) throw new Error(result.problems.join(', '));
	return result.record;
}

describe('DeviceStorage', () => {
	it('isolates logs, sessions, drafts and stations by user, including after reopening', async () => {
		const name = `accounts-test-${++counter}`;
		const device = await DeviceStorage.open(name);
		await device.local.qsos.put(record('legacy'));
		const a = await device.forUser('a');
		await a.qsos.put(record('a-qso'));
		for (const key of ['session', 'draft', 'stations']) await a.kv.set(key, { owner: 'a' });
		const b = await device.forUser('b');
		expect(await b.qsos.list()).toEqual([]);
		for (const key of ['session', 'draft', 'stations']) expect(await b.kv.get(key)).toBeUndefined();
		expect((await device.local.qsos.list()).map((r) => r.id)).toEqual(['legacy']);
		const reopened = await (await DeviceStorage.open(name)).forUser('a');
		expect((await reopened.qsos.unsynced()).map((r) => r.id)).toEqual(['a-qso']);
		expect(await reopened.kv.get('session')).toEqual({ owner: 'a' });
	});

	it('imports local records only into the selected account and resumes without overwriting', async () => {
		const device = await DeviceStorage.open(`accounts-test-${++counter}`);
		await device.local.qsos.put({
			...record('local'),
			stationId: 'old-station',
			syncState: 'synced'
		});
		await device.local.qsos.put(record('copied'));
		const a = await device.forUser('a');
		const synced = { ...record('copied'), syncState: 'synced' as const, syncAttempts: 3 };
		await a.qsos.put(synced);
		await device.importLocal('a');
		expect(await device.local.qsos.list()).toEqual([]);
		expect(await a.qsos.get('local')).toMatchObject({ syncState: 'pending', stationId: undefined });
		expect(await a.qsos.get('copied')).toEqual(synced);
		expect(await (await device.forUser('b')).qsos.list()).toEqual([]);
	});
});
