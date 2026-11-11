/** The 44px icon button that closes a dialog, a drawer or a toast. Its name is «إغلاق». */
export function CloseButton({ onClose }: { onClose(): void }) {
  return (
    <button type="button" class="icon-btn" aria-label="إغلاق" data-layer-close onClick={onClose}>
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" />
      </svg>
    </button>
  );
}
