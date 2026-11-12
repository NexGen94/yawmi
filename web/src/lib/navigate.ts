// Navigation from outside a component (keyboard shortcuts, the ask controller). preact-iso's
// LocationProvider re-reads location on popstate, so pushing a history entry and announcing it
// routes the app exactly like a link click does.
export function navigate(url: string): void {
  if (location.pathname + location.search === url) return;
  history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}
