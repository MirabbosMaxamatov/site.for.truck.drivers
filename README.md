TruckerHub — Local Development & PWA Test Guide

This project is a mobile-first Progressive Web App (PWA) scaffold for truck drivers. It includes an offline-capable service worker, manifest, and simple client logic.

Quick Start (local)

1) Serve from a local web server

Service workers require a secure context (HTTPS) or `localhost`. Use a simple static server. If you have Node.js installed:

```bash
npx http-server -c-1 . -p 8080
```

Or using Python (modern):

```bash
python -m http.server 8080
```

Open: http://localhost:8080

Test PWA & Offline behavior

1. Open Chrome DevTools > Application.
2. Verify the manifest is loaded (Application > Manifest).
3. Check that `sw.js` is registered under Application > Service Workers.
4. Click the install banner or use the browser install UI to add the app to your device.

To test offline:

1. In DevTools > Network, select `Offline`.
2. Reload the page — the app shell should load from the service worker cache.

Notes & Next Steps

- Place real icons at `icons/icon-192.png` and `icons/icon-512.png` for proper install UX.
- The service worker uses a precache for core assets and a runtime cache with a simple LRU trimming. Tune `RUNTIME_CACHE_MAX_ENTRIES` in `sw.js`.
- Camera functionality requires HTTPS on real devices (or `localhost`).

PWA Install

- The app listens for `beforeinstallprompt` and shows a custom install banner. On click it triggers the native install prompt when eligible.

Troubleshooting

- If the service worker does not appear, make sure you are serving from `http://localhost` or `https://` and that `sw.js` is reachable.
- Clear existing service workers and caches from DevTools > Application if you change cache names.
# site.for.truck.drivers
