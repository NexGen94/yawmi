// @vitest-environment happy-dom
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { SourceCards } from '../../src/ai/SourceCards';

const card = (trend: (number | null)[]) => ({ source_id: 'h:a', label: 'تنفّس بطيء', value: 0, unit: 'من 1', text: null, trend }) as never;

describe('SourceCards: a trend of one day is not drawn (Task 24)', () => {
  it('draws no line for one point or none, which looked like a rendering fault, and one for two or more', () => {
    for (const trend of [[], [3], [null, 3], [null, null]]) {
      const { container, unmount } = render(<SourceCards cards={[card(trend)]} />);
      expect(container.querySelector('.spark'), JSON.stringify(trend)).toBeNull();
      unmount();
    }
    const two = render(<SourceCards cards={[card([1, 2])]} />);
    expect(two.container.querySelector('.spark')).not.toBeNull();
  });
});
