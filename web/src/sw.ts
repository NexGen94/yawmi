import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

// The build injects the list of shell files here. Nothing else is cached: there is no
// runtime caching, so API calls under /v1 always go to the network.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations fall back to the precached index.html (single-page app), except /v1.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/v1\//] }));

// A waiting worker takes over only when the page asks for it (the update prompt).
self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
