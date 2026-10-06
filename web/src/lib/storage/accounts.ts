import { stationDefaults, type QsoRecord, type StationList } from '../qso';
import { KeyValueStore, QsoStore, openDatabase, type Database } from './db';

export interface AccountStores {
	qsos: QsoStore;
	kv: KeyValueStore;
}

/** Legacy and signed-out data stays local until its owner explicitly imports it. */
export class DeviceStorage {
	readonly globals: KeyValueStore;
	readonly local: AccountStores;
	#accounts = new Map<string, Promise<AccountStores>>();

	private constructor(
		db: Database,
		private readonly name: string
	) {
		this.local = { qsos: new QsoStore(db), kv: new KeyValueStore(db) };
		this.globals = this.local.kv;
	}

	static async open(name = 'speech-to-qso'): Promise<DeviceStorage> {
		return new DeviceStorage(await openDatabase(name), name);
	}

	forUser(userId: string | null): Promise<AccountStores> {
		if (userId === null) return Promise.resolve(this.local);
		let stores = this.#accounts.get(userId);
		if (stores === undefined) {
			stores = openDatabase(`${this.name}:user:${userId}`).then((db) => ({
				qsos: new QsoStore(db),
				kv: new KeyValueStore(db)
			}));
			this.#accounts.set(userId, stores);
		}
		return stores;
	}

	async importLocal(userId: string): Promise<void> {
		const { qsos } = await this.forUser(userId);
		const stations = await this.local.kv.get<StationList>('stations');
		for (const record of await this.local.qsos.list()) {
			// Copy before deleting; interrupted imports can resume without changing synced copies.
			if ((await qsos.get(record.id)) === undefined) {
				const stationId = record.stationId ?? stations?.default_station_id;
				const defaults = stationDefaults(stations?.stations.find((s) => s.id === stationId));
				const imported: QsoRecord = {
					...record,
					stationCallsign: record.stationCallsign ?? defaults.stationCallsign,
					location: record.location || defaults.location || '',
					potaReference: record.potaReference ?? defaults.potaReference,
					myJcx: record.myJcx ?? defaults.myJcx,
					stationId: undefined,
					syncState: 'pending',
					syncAttempts: 0,
					syncError: undefined,
					syncedAt: undefined
				};
				await qsos.put(imported);
			}
			await this.local.qsos.delete(record.id);
		}
	}
}
