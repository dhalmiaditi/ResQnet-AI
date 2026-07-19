const CACHE_NAME = 'resqnet-v1';
const CACHE_URLS = [
    '/',
    '/dashboard',
    '/sos',
    '/report',
    '/static/styles.css',
    '/static/script.js',
    '/static/manifest.json',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install — cache all core files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(CACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', event => {
    // Never cache API calls or SOS — always use network for these
    if (event.request.url.includes('/api/') || event.request.url.includes('/track/')) {
        event.respondWith(fetch(event.request).catch(() => new Response('{"status":"offline"}', { headers: {'Content-Type':'application/json'} })));
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                if (cached) return cached;
                return fetch(event.request)
                    .then(response => {
                        // Cache new successful GET requests
                        if (event.request.method === 'GET' && response.status === 200) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    })
                    .catch(() => caches.match('/'));
            })
    );
});

// Background sync — send queued SOS when back online
self.addEventListener('sync', event => {
    if (event.tag === 'sos-sync') {
        event.waitUntil(sendQueuedSOS());
    }
});

async function sendQueuedSOS() {
    const db     = await getQueuedSOS();
    const queued = await db.getAll();
    for (const item of queued) {
        try {
            await fetch('/api/sos', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(item)
            });
            await db.delete(item.id);
        } catch {}
    }
}