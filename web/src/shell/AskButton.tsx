import { openAsk } from '../ask/controller';

// «اسأل» in the header. The shortcut hint names keys, not characters: Ctrl+K and / work on the
// Arabic layout because lib/keys.ts matches the physical key.
export function AskButton() {
  return (
    <button type="button" class="ask-button" aria-label="اسأل" aria-keyshortcuts="Control+K Meta+K /" onClick={() => openAsk()}>
      <svg class="ask-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 5.5h14v10h-8.5L6 19.5v-4H5z" />
        <path d="M9 9.5h6M9 12h3.5" />
      </svg>
      <span>اسأل</span>
      {/* Drawn by CSS from data-keys: the keys are a hint for the eye (aria-keyshortcuts tells
          assistive technology), not part of the button's name, so the visible text stays «اسأل». */}
      <kbd class="ask-kbd" dir="ltr" aria-hidden="true" data-keys="Ctrl+K" />
    </button>
  );
}
