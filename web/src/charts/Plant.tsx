import './focus-charts.css';
import { useEffect, useState } from 'preact/hooks';

import { fmt } from '../lib/format';

export interface PlantProps {
  /** 0 (a seed) to 4 (in bud): `plantStage` of the session. */
  stage: 0 | 1 | 2 | 3 | 4;
}

const QUERY = '(prefers-reduced-motion: reduce)';

/** Whether the person asked the system for less motion (and when that changes). */
export function useReducedMotion(): boolean {
  const media = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia(QUERY) : null);
  const [reduced, setReduced] = useState(() => media()?.matches ?? false);
  useEffect(() => {
    const list = media();
    if (!list) return;
    const update = (): void => setReduced(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** The plant of a focus session: it grows one part at a time as the session goes (design 9.5). It
 *  is drawn for the ink surface of the session card. The stage is also written in the label, so
 *  nothing depends on seeing it. With `prefers-reduced-motion` the parts appear without growing. */
export function Plant({ stage }: PlantProps) {
  const reduced = useReducedMotion();
  const on = (n: number): 'true' | 'false' => (stage >= n ? 'true' : 'false');
  return (
    <svg
      class={reduced ? 'chart plant plant-still' : 'chart plant'}
      role="img"
      aria-label={`نبتة التركيز: المرحلة ${fmt.num(stage)} من ${fmt.num(4)}`}
      viewBox="0 0 120 120"
      width="120"
      height="120"
      focusable="false"
    >
      <circle class="plant-seed" cx="60" cy="90" r="3.5" />
      <g class="plant-part" data-on={on(1)}>
        <path class="plant-stem" d="M60 92V70" />
      </g>
      <g class="plant-part" data-on={on(2)}>
        <ellipse class="plant-leaf" cx="47" cy="78" rx="11" ry="5.5" transform="rotate(-25 47 78)" />
        <ellipse class="plant-leaf" cx="73" cy="78" rx="11" ry="5.5" transform="rotate(25 73 78)" />
      </g>
      <g class="plant-part" data-on={on(3)}>
        <path class="plant-stem" d="M60 72V48" />
        <ellipse class="plant-leaf" cx="48" cy="58" rx="10" ry="5" transform="rotate(-30 48 58)" />
        <ellipse class="plant-leaf" cx="72" cy="58" rx="10" ry="5" transform="rotate(30 72 58)" />
      </g>
      <g class="plant-part" data-on={on(4)}>
        <circle class="plant-bud" cx="60" cy="41" r="9" />
        <circle class="plant-bud-core" cx="60" cy="41" r="3.5" />
      </g>
      <path class="plant-pot" d="M38 92h44l-6 22H44z" />
    </svg>
  );
}
