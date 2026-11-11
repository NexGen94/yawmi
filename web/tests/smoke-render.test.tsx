// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { useEffect, useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';

// Proof that the component-test stack works with the pinned Preact: JSX is transformed, a real
// render reaches the DOM, role queries find it, and happy-dom gets an indexedDB from the setup.
describe('component test infrastructure', () => {
  it('renders JSX with @testing-library/preact and queries it by role and name', () => {
    render(<button type="button">تجربة</button>);
    expect(screen.getByRole('button', { name: 'تجربة' })).toBeTruthy();
  });

  it('cleans the DOM between tests', () => {
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('provides indexedDB (happy-dom has none of its own)', () => {
    expect(typeof indexedDB).toBe('object');
    expect(typeof indexedDB.open).toBe('function');
  });

  it('flushes state updates and effects triggered by an event', () => {
    function Counter() {
      const [n, setN] = useState(0);
      const [seen, setSeen] = useState(0);
      useEffect(() => setSeen(n), [n]);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {`عدّ ${n} / ${seen}`}
        </button>
      );
    }
    render(<Counter />);
    fireEvent.click(screen.getByRole('button', { name: 'عدّ 0 / 0' }));
    expect(screen.getByRole('button', { name: 'عدّ 1 / 1' })).toBeTruthy();
  });
});
