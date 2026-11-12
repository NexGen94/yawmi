import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';

import { Unauthorized } from './api/auth';
import { App } from './app';
import { navigate } from './lib/navigate';
import { UpdatePrompt } from './shell/UpdatePrompt';
import './styles/index.css';
import { installFlushTriggers } from './sync/triggers';

// Flush the outbox when online, foregrounded or launched; redirect to pairing on Unauthorized.
installFlushTriggers(undefined, {
  onError: (error) => {
    if (error instanceof Unauthorized) {
      navigate('/pair');
    }
  },
});

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing from index.html');

// With registerType 'prompt' a new version waits instead of swapping silently. onNeedRefresh
// shows the prompt; «تحديث الآن» sends SKIP_WAITING (the worker applies it) and reloads.
const updateSW = registerSW({ onNeedRefresh: () => mount(true) });

function mount(needRefresh: boolean): void {
  render(
    <>
      <App />
      <UpdatePrompt needRefresh={needRefresh} onUpdate={() => void updateSW(true)} />
    </>,
    root as HTMLElement,
  );
}

mount(false);
