// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import { EditError } from '../../src/goals/edits';
import { EditField } from '../../src/pages/goals/EditField';

const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

function date(onSave: (v: string) => Promise<void> = async () => undefined) {
  render(<EditField kind="date" label="الموعد" context="محطة" value="2026-11-08" pending={false} disabled={false} onSave={onSave} />);
}

const openButton = (): HTMLElement => screen.getByRole('button', { name: /^تعديل الموعد/ });

describe('EditField: focus goes back to «تعديل» when the field closes (I-1)', () => {
  it('after «حفظ»', async () => {
    date();
    fireEvent.click(openButton());
    fireEvent.input(screen.getByLabelText('الموعد'), { target: { value: '2026-11-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(document.activeElement).toBe(openButton()));
  });

  it('after «إلغاء»', async () => {
    date();
    fireEvent.click(openButton());
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(document.activeElement).toBe(openButton()));
  });

  it('after Escape', async () => {
    date();
    fireEvent.click(openButton());
    fireEvent.keyDown(screen.getByLabelText('الموعد'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(openButton()));
  });

  it('goes into the input when the field opens, and stays on the field when a save is refused', async () => {
    date(async () => {
      throw new EditError('القيمة غير مقبولة.');
    });
    fireEvent.click(openButton());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('الموعد')));
    fireEvent.input(screen.getByLabelText('الموعد'), { target: { value: '2026-11-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('الموعد')).toBeTruthy();
  });
});

describe('EditField: the toggle keeps its new value while the save is in flight (M-3)', () => {
  const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: /^منجزة/ }) as HTMLInputElement;
  const field = (value: boolean, pending: boolean, save: () => Promise<void>) => (
    <EditField kind="toggle" label="منجزة" context="محطة" value={value} pending={pending} disabled={false} onSave={save} />
  );

  it('stays checked until the save settles, then shows the value it was given', async () => {
    const wait = deferred();
    const save = () => wait.promise;
    const view = render(field(false, false, save));
    fireEvent.click(box());
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(true);
    // a re-render while it is in flight (the page re-reads the plan) does not flip it back
    view.rerender(field(false, false, save));
    expect(box().checked).toBe(true);
    wait.resolve();
    view.rerender(field(true, true, save));
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(true);
  });

  it('goes back to the old value, with the reason, when the save is refused', async () => {
    const wait = deferred();
    render(field(false, false, () => wait.promise));
    fireEvent.click(box());
    expect(box().checked).toBe(true);
    wait.reject(new EditError('يحتاج اتصالاً'));
    expect((await screen.findByRole('alert')).textContent).toBe('يحتاج اتصالاً');
    expect(box().checked).toBe(false);
  });
});
