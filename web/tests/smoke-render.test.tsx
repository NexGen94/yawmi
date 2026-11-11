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

// Preact 11 defers the cleanup of a useEffect on unmount. If the per-test cleanup does not run
// inside act(), an effect of one test is still alive in the next (a leaked document listener
// is exactly what the page tasks would hit with online/offline, shortcuts and timers).
describe('effects do not leak into the next test', () => {
  const log = { keydowns: 0, cleanups: 0 };

  function Listener() {
    useEffect(() => {
      const onKey = (): void => {
        log.keydowns += 1;
      };
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('keydown', onKey);
        log.cleanups += 1;
      };
    }, []);
    return <p>مستمع</p>;
  }

  it('test A mounts a component whose effect listens on document', () => {
    render(<Listener />);
    document.dispatchEvent(new KeyboardEvent('keydown'));
    expect(log).toEqual({ keydowns: 1, cleanups: 0 });
  });

  it('test B sees the effect of test A already cleaned up', () => {
    expect(log.cleanups).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown'));
    expect(log.keydowns).toBe(1);
  });
});
