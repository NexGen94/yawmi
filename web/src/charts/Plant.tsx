import './focus-charts.css';
import { useEffect, useState } from 'preact/hooks';

import { fmt } from '../lib/format';
import { x } from './rtl';

export interface PlantProps {
  /** 0 (a seed) to 4 (in bud): `plantStage` of the session. */
  stage: 0 | 1 | 2 | 3 | 4;
}

const SIZE = 120;
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
  // The plant stands on the middle line, found through rtl.ts like every chart's horizontal position.
  const mid = x(0, 1, SIZE);
  const on = (n: number): 'true' | 'false' => (stage >= n ? 'true' : 'false');
  return (
    <svg
      class={reduced ? 'chart plant plant-still' : 'chart plant'}
      role="img"
      aria-label={`نبتة التركيز: المرحلة ${fmt.num(stage)} من ${fmt.num(4)}`}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      focusable="false"
    >
      <circle class="plant-seed" cx={mid} cy="90" r="3.5" />
      <g class="plant-part" data-on={on(1)}>
        <path class="plant-stem" d={`M${mid} 92V70`} />
      </g>
      <g class="plant-part" data-on={on(2)}>
        <ellipse class="plant-leaf" cx={mid - 13} cy="78" rx="11" ry="5.5" transform={`rotate(-25 ${mid - 13} 78)`} />
        <ellipse class="plant-leaf" cx={mid + 13} cy="78" rx="11" ry="5.5" transform={`rotate(25 ${mid + 13} 78)`} />
      </g>
      <g class="plant-part" data-on={on(3)}>
        <path class="plant-stem" d={`M${mid} 72V48`} />
        <ellipse class="plant-leaf" cx={mid - 12} cy="58" rx="10" ry="5" transform={`rotate(-30 ${mid - 12} 58)`} />
        <ellipse class="plant-leaf" cx={mid + 12} cy="58" rx="10" ry="5" transform={`rotate(30 ${mid + 12} 58)`} />
      </g>
      <g class="plant-part" data-on={on(4)}>
        <circle class="plant-bud" cx={mid} cy="41" r="9" />
        <circle class="plant-bud-core" cx={mid} cy="41" r="3.5" />
      </g>
      <path class="plant-pot" d={`M${mid - 22} 92h44l-6 22H${mid - 16}z`} />
    </svg>
  );
}
