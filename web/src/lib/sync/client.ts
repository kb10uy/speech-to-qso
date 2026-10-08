import { ApiError, type QsoResult } from '../account/api';
import { toApiPayload, type QsoApiPayload, type QsoRecord } from '../qso';

export interface QsoSender {
    postQso(payload: QsoApiPayload): Promise<QsoResult>;
}

export interface SyncTarget {
    unsynced(): Promise<QsoRecord[]>;
    put(record: QsoRecord): Promise<void>;
}

export interface SyncReport {
    synced: number;
    failed: number;
    /** The session has ended; nothing more can be sent until the user signs in again. */
    unauthorized: boolean;
}

/**
 * Sends every unsynced QSO, oldest first. Each record's state is persisted as soon as it is
 * known, so a crash or lost connection never loses a QSO or its sync status.
 */
export async function syncAll(
    store: SyncTarget,
    sender: QsoSender,
    now: () => Date = () => new Date(),
    shouldContinue: () => boolean = () => true
): Promise<SyncReport> {
    const report: SyncReport = { synced: 0, failed: 0, unauthorized: false };

    for (const record of await store.unsynced()) {
        if (!shouldContinue()) break;
        try {
            await sender.postQso(toApiPayload(record));
            await store.put({
                ...record,
                syncState: 'synced',
                syncAttempts: record.syncAttempts + 1,
                syncError: undefined,
                syncedAt: now().toISOString()
            });
            report.synced += 1;
        } catch (e) {
            const error = e instanceof ApiError ? e : new ApiError(String(e), 0);
            // Not the QSO's fault; it waits, untouched, until the user signs in again.
            if (error.unauthorized) {
                report.unauthorized = true;
                break;
            }
            await store.put({
                ...record,
                syncState: 'failed',
                syncAttempts: record.syncAttempts + 1,
                syncError: error.message
            });
            report.failed += 1;
            // Network problems will affect the rest too; stop and retry later.
            if (error.status === 0) break;
        }
    }
    return report;
}
