// Shown when the service worker has a new version waiting (registerType 'prompt'): nothing
// swaps under an open session until «تحديث الآن» is chosen.
export function UpdatePrompt(props: { needRefresh: boolean; onUpdate(): void }) {
  if (!props.needRefresh) return null;
  return (
    <div class="update-prompt" role="status" aria-live="polite">
      <p class="update-text">نسخة جديدة متاحة</p>
      <button type="button" class="update-button" onClick={() => props.onUpdate()}>
        تحديث الآن
      </button>
    </div>
  );
}
