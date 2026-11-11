import { AskButton } from './AskButton';

// The header above every page: the «اسأل» entry point. Each page writes its own <h1> below it.
export function TopBar() {
  return (
    <header class="topbar">
      <AskButton />
    </header>
  );
}
