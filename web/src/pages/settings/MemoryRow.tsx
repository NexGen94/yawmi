import type { MemoryItem } from '../../settings/aiData';

export interface MemoryRowProps {
  item: MemoryItem;
  disabled: boolean;
  onToggle(item: MemoryItem, active: boolean): void;
  onRemove(item: MemoryItem): void;
}

/** One item of the memory as it is sent: its text, a switch that keeps it listed but stops sending
 *  it, and the real deletion in one tap. */
export function MemoryRow({ item, disabled, onToggle, onRemove }: MemoryRowProps) {
  return (
    <li class="memory-row" data-active={item.active ? 'true' : 'false'}>
      <span class="memory-text" dir="auto">
        {item.text}
      </span>
      <div class="memory-actions">
        <button
          type="button"
          role="switch"
          class="btn btn-quiet"
          aria-checked={item.active ? 'true' : 'false'}
          aria-label={`${item.active ? 'مفعّلة' : 'معطّلة'} · ${item.text}`}
          disabled={disabled}
          onClick={() => onToggle(item, !item.active)}
        >
          {item.active ? 'مفعّلة' : 'معطّلة'}
        </button>
        <button
          type="button"
          class="btn btn-quiet"
          aria-label={`حذف «${item.text}»`}
          disabled={disabled}
          onClick={() => onRemove(item)}
        >
          حذف
        </button>
      </div>
    </li>
  );
}
