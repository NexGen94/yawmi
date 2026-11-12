// Shown when the service worker has a new version waiting (registerType 'prompt'): nothing
// swaps under an open session until «تحديث الآن» is chosen. The polite live region stays mounted
// empty so screen readers announce the text when it is inserted.
export function UpdatePrompt(props: { needRefresh: boolean; onUpdate(): void }) {
  return (
    <div class="update-prompt" role="status" aria-live="polite">
      {props.needRefresh ? (
        <>
          <p class="update-text">نسخة جديدة متاحة</p>
          <button type="button" class="update-button" onClick={() => props.onUpdate()}>
            تحديث الآن
          </button>
        </>
      ) : null}
    </div>
  );
}
