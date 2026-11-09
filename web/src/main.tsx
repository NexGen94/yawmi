import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';

import { App } from './app';
import './styles/base.css';

// Registers the service worker. With registerType 'prompt' a new version waits instead of
// swapping silently. TODO(design): pass onNeedRefresh to the update prompt once the design
// is approved; the worker already applies the update on a SKIP_WAITING message.
registerSW();

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing from index.html');
render(<App />, root);
