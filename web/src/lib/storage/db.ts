import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { QsoRecord } from '../qso';

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

export function openDatabase(name: string = DB_NAME): Promise<Database> {
	return openDB<QsoDb>(name, 1, {
		upgrade(db) {
			const qsos = db.createObjectStore('qsos', { keyPath: 'id' });
			qsos.createIndex('createdAt', 'createdAt');
			qsos.createIndex('syncState', 'syncState');
			db.createObjectStore('kv');
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
