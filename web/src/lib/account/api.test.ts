import { describe, expect, it, vi } from 'vitest';
import { ApiError, ServerApi } from './api';

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('ServerApi.request', () => {
	it('binds authenticated requests to the intended user but permits a new sign-in', async () => {
		const fetchMock = vi.fn(async () => json(200, []));
		const api = new ServerApi(fetchMock).forUser('user-a');
		await api.stations();
		await api.startBootstrap('setup-token');
		const first = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(first[1].headers).toMatchObject({ 'X-QSO-User': 'user-a' });
		expect(second[1].headers).not.toHaveProperty('X-QSO-User');
	});
	it('sends JSON to the same origin with the session cookie', async () => {
		const fetchMock = vi.fn(async () => json(200, { id: 'u', callsign: 'JJ1ABC' }));
		const api = new ServerApi(fetchMock);
		await api.setDefaultStation('s1');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/stations/default');
		expect(init.method).toBe('PUT');
		expect(init.credentials).toBe('same-origin');
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
		expect(JSON.parse(init.body as string)).toEqual({ station_id: 's1' });
	});

	it('looks up callsigns with the callsign in the query', async () => {
		const history = { callsign: 'JA1ABC/1', qsos: 0, last_qso: null, last_qsl_sent: null };
		const fetchMock = vi.fn(async () => json(200, history));
		await expect(new ServerApi(fetchMock).callsignHistory('JA1ABC/1')).resolves.toEqual(history);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/wavelog/history?callsign=JA1ABC%2F1');
		expect(init.method).toBe('GET');
	});

	it('returns nothing for 204', async () => {
		const api = new ServerApi(vi.fn(async () => new Response(null, { status: 204 })));
		await expect(api.logout()).resolves.toBeUndefined();
	});

	it('classifies errors', async () => {
		const failing = (response: () => Response) => new ServerApi(vi.fn(async () => response()));

		const unprocessable = await failing(() =>
			json(422, { status: 'error', error: 'rst_rcvd: bad' })
		)
			.me()
			.catch((e) => e);
		expect(unprocessable).toBeInstanceOf(ApiError);
		expect(unprocessable).toMatchObject({ status: 422, message: 'HTTP 422: rst_rcvd: bad' });
		expect(unprocessable.retryable).toBe(false);

		const unauthorized = await failing(() => json(401, { error: 'not signed in' }))
			.me()
			.catch((e) => e);
		expect(unauthorized.unauthorized).toBe(true);
		expect(unauthorized.retryable).toBe(false);

		const gateway = await failing(() => new Response('nope', { status: 502 }))
			.me()
			.catch((e) => e);
		expect(gateway).toMatchObject({ status: 502, message: 'HTTP 502: nope', retryable: true });

		const html = await failing(() => new Response('<!doctype html>', { status: 200 }))
			.me()
			.catch((e) => e);
		expect(html).toMatchObject({ status: 0, retryable: true });

		const offline = await new ServerApi(
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			})
		)
			.me()
			.catch((e) => e);
		expect(offline).toMatchObject({ status: 0, message: 'network error: Failed to fetch' });
	});

	it('omits an empty Wavelog token so the stored one is kept', async () => {
		const fetchMock = vi.fn(async () => json(200, { default_station_id: null, stations: [] }));
		await new ServerApi(fetchMock).connectWavelog('https://log.example.com', '  ');
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ url: 'https://log.example.com' });
	});
});
