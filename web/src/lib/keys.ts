import { openAsk } from '../ask/controller';
import { navigate } from './navigate';

// Keyboard shortcuts (design section 3). Matched on KeyboardEvent.code, the physical key, never
// on key: on the Arabic layout K types «ن» and / types «ظ», so key would never match.
//   Ctrl or Meta + K   «اسأل», from anywhere, inside fields too
//   /                  «اسأل», outside fields
//   G then H, D, A, O  the home page, the day, habits, goals (outside fields)

const GO_TO: Readonly<Record<string, string>> = {
  KeyH: '/',
  KeyD: '/day',
  KeyA: '/habits',
  KeyO: '/goals',
};

/** How long after G the second key still counts, in milliseconds. */
const SEQUENCE_MS = 1500;

const FIELD_SELECTOR = 'input, textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"]';

/** True when the key press belongs to text entry: an input, textarea, select, ARIA text/combo/search box, or editable element. */
function inField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(FIELD_SELECTOR)) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

/** Installs the shortcuts on document. Returns the function that removes them. */
export function installShortcuts(): () => void {
  let gAt = -Infinity;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const { code } = event;

    if (code === 'KeyK' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      gAt = -Infinity;
      openAsk();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || inField(event.target)) {
      gAt = -Infinity;
      return;
    }

    if (code === 'Slash' && !event.shiftKey) {
      event.preventDefault();
      gAt = -Infinity;
      openAsk();
      return;
    }

    if (event.shiftKey) {
      gAt = -Infinity;
      return;
    }
    const now = Date.now();
    const target = GO_TO[code];
    if (target !== undefined && now - gAt <= SEQUENCE_MS) {
      event.preventDefault();
      gAt = -Infinity;
      navigate(target);
      return;
    }
    gAt = code === 'KeyG' ? now : -Infinity;
  };

  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
