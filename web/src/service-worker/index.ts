/**
 * Offline support: precache the app shell so the app starts, recognises speech and logs QSOs
 * without network. The Vosk model is not cached here; vosk-browser persists it in IndexedDB.
 */
import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';

const CACHE = `speech-to-qso-${version}`;

const scope = () => new URL(self.registration.scope);
const toUrl = (path: string) => new URL(path, scope()).href;

/** Build output, static files (except the model) and the SPA shell, de-duplicated for addAll. */
const precacheUrls = () => [
    ...new Set([
        scope().href,
        ...[...immutable, ...assets, ...prerendered]
            .map(({ path }) => path)
            .filter((path) => !path.startsWith('models/'))
            .map(toUrl)
    ])
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(precacheUrls())));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
            )
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== location.origin || !url.href.startsWith(scope().href)) return;
    // The API is never cached; offline requests fail and the app keeps QSOs locally.
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE);

            // Hashed build output and static files never change within a version.
            const cached = await cache.match(request, { ignoreSearch: true });
            if (cached && request.mode !== 'navigate') return cached;

            try {
                const response = await fetch(request);
                if (response.ok && request.mode === 'navigate') {
                    await cache.put(scope().href, response.clone());
                }
                return response;
            } catch (e) {
                // Offline: every navigation gets the cached SPA shell.
                const fallback =
                    request.mode === 'navigate' ? await cache.match(scope().href) : cached;
                if (fallback) return fallback;
                throw e;
            }
        })()
    );
});
