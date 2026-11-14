import type { TargetedKeyboardEvent } from 'preact';
import { useId } from 'preact/hooks';

import { fmt } from '../lib/format';
import { rowStep } from './direction';

export interface SliderProps {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange(value: number): void;
  /** Spoken value when the number alone is not enough («7 من 10»). */
  valueText?(value: number): string;
  /** Nobody has moved it: «—» instead of the number, an empty thumb and no fill. */
  unset?: boolean;
}

/** A native range input with its value shown as a number beside the label. The keys are handled
 *  here so they behave the same in every browser and follow the eye in RTL: ArrowUp and ArrowLeft
 *  raise, ArrowDown and ArrowRight lower, Home and End jump, PageUp and PageDown move a tenth. */
export function Slider({ label, min, max, step = 1, value, onChange, valueText, unset = false }: SliderProps) {
  const id = useId();
  const snap = (v: number): number => {
    const stepped = min + Math.round((v - min) / step) * step;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(6))));
  };

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLInputElement>): void => {
    const big = Math.max(step, Math.round((max - min) / 10 / step) * step);
    let next: number;
    switch (event.key) {
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      case 'PageUp':
        next = value + big;
        break;
      case 'PageDown':
        next = value - big;
        break;
      case 'ArrowUp':
        next = value + step;
        break;
      case 'ArrowDown':
        next = value - step;
        break;
      default: {
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? rowStep(event.key, event.currentTarget) : 0;
        if (direction === 0) return;
        next = value + direction * step;
      }
    }
    event.preventDefault();
    onChange(snap(next));
  };

  return (
    <div class="slider" data-unset={unset ? 'true' : undefined}>
      <div class="slider-head">
        <label class="slider-label" for={id}>
          {label}
        </label>
        <span class="slider-value num" aria-hidden="true">
          {unset ? '—' : fmt.num(value)}
        </span>
      </div>
      <div class="slider-box">
        <span class="slider-rail" aria-hidden="true">
          <span class="slider-fill" style={{ inlineSize: `${unset ? 0 : ((value - min) / (max - min)) * 100}%` }} />
        </span>
        <input
          id={id}
          class="slider-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={unset ? 'لم يُحدَّد' : valueText?.(value)}
          onInput={(event) => onChange(snap(Number(event.currentTarget.value)))}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
