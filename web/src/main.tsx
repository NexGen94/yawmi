import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';

import { App } from './app';
import { UpdatePrompt } from './shell/UpdatePrompt';
import './styles/index.css';

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
