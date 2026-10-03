import { toApiPayload, type QsoRecord } from '../qso';

export interface SyncSettings {
	/** Base URL of the backend, e.g. `https://qso.example.com`. Empty disables sync. */
	endpoint: string;
	/** Bearer token expected by the backend. */
	token: string;
}

export function isSyncConfigured(settings: SyncSettings): boolean {
	return settings.endpoint.trim() !== '';
}

export function qsoEndpoint(settings: SyncSettings): string {
	return settings.endpoint.trim().replace(/\/+$/, '') + '/api/qso';
}

export class SyncError extends Error {
	constructor(
		message: string,
		/** False for errors that will not go away by retrying (e.g. validation errors). */
		readonly retryable: boolean
	) {
		super(message);
		this.name = 'SyncError';
	}
}

/** Sends one QSO to the backend. The backend de-duplicates by `id`, so retries are safe. */
export async function postQso(
	record: QsoRecord,
	settings: SyncSettings,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	let response: Response;
	try {
		response = await fetchImpl(qsoEndpoint(settings), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(settings.token !== '' ? { Authorization: `Bearer ${settings.token}` } : {})
			},
			body: JSON.stringify(toApiPayload(record))
		});
	} catch (e) {
		throw new SyncError(`network error: ${e instanceof Error ? e.message : String(e)}`, true);
	}
	if (response.ok) return;

	const detail = (await response.text().catch(() => '')).slice(0, 200);
	const message = `HTTP ${response.status}${detail !== '' ? `: ${detail}` : ''}`;
	const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
	throw new SyncError(message, retryable);
}

export interface SyncTarget {
	unsynced(): Promise<QsoRecord[]>;
	put(record: QsoRecord): Promise<void>;
}

export interface SyncReport {
	synced: number;
	failed: number;
}

/**
 * Sends every unsynced QSO, oldest first. Each record's state is persisted as soon as it is
 * known, so a crash or lost connection never loses a QSO or its sync status.
 */
export async function syncAll(
	store: SyncTarget,
	settings: SyncSettings,
	fetchImpl: typeof fetch = fetch,
	now: () => Date = () => new Date()
): Promise<SyncReport> {
	const report: SyncReport = { synced: 0, failed: 0 };
	if (!isSyncConfigured(settings)) return report;

	for (const record of await store.unsynced()) {
		try {
			await postQso(record, settings, fetchImpl);
			await store.put({
				...record,
				syncState: 'synced',
				syncAttempts: record.syncAttempts + 1,
				syncError: undefined,
				syncedAt: now().toISOString()
			});
			report.synced += 1;
		} catch (e) {
			const error = e instanceof SyncError ? e : new SyncError(String(e), true);
			await store.put({
				...record,
				syncState: 'failed',
				syncAttempts: record.syncAttempts + 1,
				syncError: error.message
			});
			report.failed += 1;
			// Network problems will affect the rest too; stop and retry later.
			if (error.retryable && error.message.startsWith('network error')) break;
		}
	}
	return report;
}
