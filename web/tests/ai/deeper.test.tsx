// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { DeeperChips } from '../../src/ai/DeeperChips';

const OPTIONS = [
  { title: 'ما الذي ساعد اليوم؟', source_id: 'habit:read' },
  { title: 'ما الذي عاق اليوم؟', source_id: 'habit:read' },
  { title: 'ما الخطوة التالية؟', source_id: 'goal:O1' },
];

describe('DeeperChips', () => {
  it('shows one question and keeps the others hidden', () => {
    render(<DeeperChips question="ما الذي يستحق التأمل؟" options={OPTIONS} />);
    expect(screen.getByText('ما الذي يستحق التأمل؟')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'أسئلة أخرى' })).toBeNull();
    expect(screen.getByRole('button', { name: 'أسئلة أخرى' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('«أسئلة أخرى» reveals the three chips', () => {
    render(<DeeperChips question="ما الذي يستحق التأمل؟" options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'أسئلة أخرى' }));
    const group = screen.getByRole('group', { name: 'أسئلة أخرى' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
  });

  it('shows at most three chips even if more arrive', () => {
    const more = [...OPTIONS, { title: 'سؤال رابع', source_id: 'a' }];
    render(<DeeperChips question="س؟" options={more} />);
    fireEvent.click(screen.getByRole('button', { name: 'أسئلة أخرى' }));
    expect(within(screen.getByRole('group', { name: 'أسئلة أخرى' })).getAllByRole('button')).toHaveLength(3);
  });

  it('a chip becomes the question on show, and the old question takes its place in the chips', () => {
    const { container } = render(<DeeperChips question="ما الذي يستحق التأمل؟" options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'أسئلة أخرى' }));
    fireEvent.click(screen.getByRole('button', { name: 'ما الذي عاق اليوم؟' }));
    expect(container.querySelector('.ai-question')?.textContent).toBe('ما الذي عاق اليوم؟');
    const group = screen.getByRole('group', { name: 'أسئلة أخرى' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    expect(within(group).getByRole('button', { name: 'ما الذي يستحق التأمل؟' })).toBeTruthy();
    expect(within(group).queryByRole('button', { name: 'ما الذي عاق اليوم؟' })).toBeNull();
  });

  it('without alternatives there is no button', () => {
    render(<DeeperChips question="س؟" options={[]} />);
    expect(screen.queryByRole('button', { name: 'أسئلة أخرى' })).toBeNull();
  });
});
