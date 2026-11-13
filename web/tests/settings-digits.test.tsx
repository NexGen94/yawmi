// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { act, render, screen } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { kvGet, kvSet } from '../src/data/cache';
import { fmt, getDigits, setDigits } from '../src/lib/format';
import { applyDigits, restoreDigits, useDigits } from '../src/settings/digits';
import { closeDb } from '../src/sync/outbox';

beforeEach(() => {
  closeDb();
  Object.assign(globalThis, { indexedDB: new IDBFactory() });
});

afterEach(() => {
  setDigits('latn');
  closeDb();
});

function Number12() {
  useDigits();
  return <p data-testid="n">{fmt.num(12)}</p>;
}

describe('the digits setting', () => {
  it('applying it changes every later number and draws what listens again', () => {
    render(<Number12 />);
    expect(screen.getByTestId('n').textContent).toBe('12');
    act(() => applyDigits('arab'));
    expect(getDigits()).toBe('arab');
    expect(screen.getByTestId('n').textContent).toBe('١٢');
    act(() => applyDigits('latn'));
    expect(screen.getByTestId('n').textContent).toBe('12');
  });

  it('is remembered on the device, and restored at the next start', async () => {
    applyDigits('arab');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await kvGet('digits')).toBe('arab');
    setDigits('latn');
    await restoreDigits();
    expect(getDigits()).toBe('arab');
  });

  it('ignores a remembered value that is not one of the two', async () => {
    await kvSet('digits', 'hex');
    await restoreDigits();
    expect(getDigits()).toBe('latn');
  });
});
