import type { QsoApiPayload, Station, StationInput, StationList } from '../qso';
import { authenticationJson, creationOptions, registrationJson, requestOptions } from './webauthn';

/** An API request that failed. `status` is 0 when the server could not be reached. */
export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'ApiError';
    }

    get unauthorized(): boolean {
        return this.status === 401;
    }

    /** False for errors that will not go away by retrying (e.g. validation errors). */
    get retryable(): boolean {
        return (
            this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429
        );
    }
}

export interface Me {
    id: string;
    callsign: string;
}

export interface PasskeyInfo {
    id: string;
    name: string;
    created_at: string;
    last_used_at: string | null;
}

export interface WavelogSettings {
    configured: boolean;
    url: string | null;
}

/** The user's past QSOs with a callsign, as Wavelog has them. Times are ISO 8601 in UTC. */
export interface CallsignHistory {
    callsign: string;
    qsos: number;
    last_qso: string | null;
    /** When the latest QSO whose card was sent was made (not when the card was sent). */
    last_qsl_sent: string | null;
}

export interface QsoResult {
    status: 'created' | 'duplicate';
    id: string;
    forwarded: boolean;
}

interface Ceremony {
    ceremony: string;
    options: unknown;
}

export interface BootstrapInfo extends Ceremony {
    callsign: string;
}

/** The speech-to-qso server, on the same origin as the app (session cookie). */
export class ServerApi {
    constructor(
        private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
        private readonly userId?: string
    ) {}

    forUser(userId: string): ServerApi {
        return new ServerApi(this.fetchImpl, userId);
    }

    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        let response: Response;
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        // Sign-in and setup may intentionally replace the cookie with another user's session.
        if (this.userId !== undefined && !path.startsWith('/api/auth/')) {
            headers['X-QSO-User'] = this.userId;
        }
        try {
            response = await this.fetchImpl(path, {
                method,
                credentials: 'same-origin',
                headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (e) {
            throw new ApiError(`network error: ${e instanceof Error ? e.message : String(e)}`, 0);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            let detail = text;
            try {
                detail = (JSON.parse(text) as { error?: string }).error ?? text;
            } catch {
                // not JSON
            }
            detail = detail.slice(0, 200);
            throw new ApiError(
                `HTTP ${response.status}${detail !== '' ? `: ${detail}` : ''}`,
                response.status
            );
        }
        if (response.status === 204) return undefined as T;
        try {
            return (await response.json()) as T;
        } catch {
            // e.g. a static file server without the API answering with the app's HTML.
            throw new ApiError('the server did not answer with JSON', 0);
        }
    }

    me(): Promise<Me> {
        return this.request('GET', '/api/me');
    }

    logout(): Promise<void> {
        return this.request('POST', '/api/auth/logout');
    }

    /** Signs in with any passkey registered for this site. */
    async signIn(): Promise<Me> {
        const { ceremony, options } = await this.request<Ceremony>('POST', '/api/auth/login/start');
        const credential = (await navigator.credentials.get(
            requestOptions(options)
        )) as PublicKeyCredential | null;
        if (credential === null) throw new ApiError('no passkey was selected', 0);
        return this.request('POST', '/api/auth/login/finish', {
            ceremony,
            credential: authenticationJson(credential)
        });
    }

    /** Checks a bootstrap link and starts registering the first passkey. */
    startBootstrap(token: string): Promise<BootstrapInfo> {
        return this.request('POST', '/api/auth/bootstrap/start', { token });
    }

    async finishBootstrap(started: Ceremony, name: string): Promise<Me> {
        const credential = await createCredential(started.options);
        return this.request('POST', '/api/auth/bootstrap/finish', {
            ceremony: started.ceremony,
            credential,
            name
        });
    }

    passkeys(): Promise<PasskeyInfo[]> {
        return this.request('GET', '/api/passkeys');
    }

    async addPasskey(name: string): Promise<PasskeyInfo> {
        const started = await this.request<Ceremony>('POST', '/api/passkeys/register/start');
        const credential = await createCredential(started.options);
        return this.request('POST', '/api/passkeys/register/finish', {
            ceremony: started.ceremony,
            credential,
            name
        });
    }

    renamePasskey(id: string, name: string): Promise<void> {
        return this.request('PUT', `/api/passkeys/${encodeURIComponent(id)}`, { name });
    }

    deletePasskey(id: string): Promise<void> {
        return this.request('DELETE', `/api/passkeys/${encodeURIComponent(id)}`);
    }

    wavelog(): Promise<WavelogSettings> {
        return this.request('GET', '/api/wavelog');
    }

    /** Connects Wavelog; an empty token keeps the stored one. Returns the fetched stations. */
    connectWavelog(url: string, token: string): Promise<StationList> {
        return this.request('PUT', '/api/wavelog', {
            url,
            token: token.trim() === '' ? undefined : token.trim()
        });
    }

    disconnectWavelog(): Promise<void> {
        return this.request('DELETE', '/api/wavelog');
    }

    /** Fails with 409 when Wavelog is not set up. */
    callsignHistory(callsign: string): Promise<CallsignHistory> {
        return this.request('GET', `/api/wavelog/history?callsign=${encodeURIComponent(callsign)}`);
    }

    stations(): Promise<StationList> {
        return this.request('GET', '/api/stations');
    }

    refreshStations(): Promise<StationList> {
        return this.request('POST', '/api/stations/refresh', {});
    }

    setDefaultStation(stationId: string | null): Promise<void> {
        return this.request('PUT', '/api/stations/default', { station_id: stationId });
    }

    createStation(input: StationInput): Promise<Station> {
        return this.request('POST', '/api/stations', input);
    }

    updateStation(id: string, input: StationInput): Promise<Station> {
        return this.request('PUT', `/api/stations/${encodeURIComponent(id)}`, input);
    }

    deleteStation(id: string): Promise<void> {
        return this.request('DELETE', `/api/stations/${encodeURIComponent(id)}`);
    }

    /** Sends one QSO. The server de-duplicates by `id`, so retries are safe. */
    postQso(payload: QsoApiPayload): Promise<QsoResult> {
        return this.request('POST', '/api/qso', payload);
    }
}

async function createCredential(options: unknown) {
    const credential = (await navigator.credentials.create(
        creationOptions(options)
    )) as PublicKeyCredential | null;
    if (credential === null) throw new ApiError('no passkey was created', 0);
    return registrationJson(credential);
}

/** A readable message for errors thrown by WebAuthn or the API. */
export function describeError(e: unknown): string {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
        return 'The passkey request was cancelled or timed out.';
    }
    if (e instanceof DOMException && e.name === 'InvalidStateError') {
        return 'This passkey is already registered.';
    }
    return e instanceof Error ? e.message : String(e);
}
