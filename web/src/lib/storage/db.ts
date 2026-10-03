import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DraftQso, QsoRecord } from '../qso';

interface QsoDb extends DBSchema {
	qsos: {
		key: string;
		value: QsoRecord;
		indexes: { createdAt: string; syncState: string };
	};
	kv: {
		key: string;
		value: unknown;
	};
}

export type Database = IDBPDatabase<QsoDb>;

const DB_NAME = 'speech-to-qso';

/** Version 1 stored QSL as a boolean. */
type LegacyQsl = { qslRequested?: boolean; qsl?: QsoRecord['qsl'] };

function migrateQsl<T extends LegacyQsl>(value: T): T {
	if (value.qsl !== undefined) return value;
	const { qslRequested, ...rest } = value;
	return { ...rest, qsl: qslRequested === true ? 'requested' : 'none' } as unknown as T;
}

export function openDatabase(name: string = DB_NAME): Promise<Database> {
	return openDB<QsoDb>(name, 2, {
		async upgrade(db, oldVersion, _newVersion, tx) {
			if (oldVersion < 1) {
				const qsos = db.createObjectStore('qsos', { keyPath: 'id' });
				qsos.createIndex('createdAt', 'createdAt');
				qsos.createIndex('syncState', 'syncState');
				db.createObjectStore('kv');
			}
			if (oldVersion === 1) {
				// Only IndexedDB requests are awaited here, so the upgrade transaction stays open.
				let cursor = await tx.objectStore('qsos').openCursor();
				while (cursor) {
					await cursor.update(migrateQsl(cursor.value));
					cursor = await cursor.continue();
				}
				const kv = tx.objectStore('kv');
				const draft = (await kv.get('draft')) as DraftQso | undefined;
				if (draft !== undefined) await kv.put(migrateQsl(draft), 'draft');
			}
		}
	});
}

/** Local log of QSOs. Saving here is what "LOG QSO" means; syncing happens afterwards. */
export class QsoStore {
	constructor(readonly db: Database) {}

	async put(record: QsoRecord): Promise<void> {
		await this.db.put('qsos', record);
	}

	get(id: string): Promise<QsoRecord | undefined> {
		return this.db.get('qsos', id);
	}

	async delete(id: string): Promise<void> {
		await this.db.delete('qsos', id);
	}

	/** All QSOs, newest first. */
	async list(): Promise<QsoRecord[]> {
		const all = await this.db.getAllFromIndex('qsos', 'createdAt');
		return all.reverse();
	}

	/** QSOs that still need to be sent to the backend, oldest first. */
	async unsynced(): Promise<QsoRecord[]> {
		const [pending, failed] = await Promise.all([
			this.db.getAllFromIndex('qsos', 'syncState', 'pending'),
			this.db.getAllFromIndex('qsos', 'syncState', 'failed')
		]);
		return [...pending, ...failed].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
}

/** Small key-value store for the operating session, settings and the current draft. */
export class KeyValueStore {
	constructor(readonly db: Database) {}

	async get<T>(key: string): Promise<T | undefined> {
		return (await this.db.get('kv', key)) as T | undefined;
	}

	async set<T>(key: string, value: T): Promise<void> {
		// Svelte state proxies cannot be structured-cloned; store a plain snapshot.
		await this.db.put('kv', JSON.parse(JSON.stringify(value)), key);
	}
}
