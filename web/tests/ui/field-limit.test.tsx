// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { describe, expect, it } from 'vitest';

import { Field } from '../../src/ui/Field';

function Harness(props: { max?: number; multiline?: boolean; start?: string }) {
  const [value, setValue] = useState(props.start ?? '');
  return <Field label="اليومية" value={value} onInput={setValue} maxLength={props.max} multiline={props.multiline} />;
}

describe('Field with a length limit', () => {
  it('puts the limit on the control', () => {
    render(<Harness max={200} />);
    expect(screen.getByLabelText('اليومية').getAttribute('maxlength')).toBe('200');
  });

  it('has no limit attribute without one', () => {
    render(<Harness />);
    expect(screen.getByLabelText('اليومية').hasAttribute('maxlength')).toBe(false);
  });

  it('cuts a longer input (a paste, a script) to the limit, in the control and in the value it reports', () => {
    render(<Harness max={10} multiline />);
    const box = screen.getByLabelText('اليومية') as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: 'ا'.repeat(25) } });
    expect(box.value).toBe('ا'.repeat(10));
  });

  it('shows how much is left only near the limit, and tells it to the control', () => {
    const { container } = render(<Harness max={100} start={'ا'.repeat(50)} />);
    expect(container.querySelector('.field-count')).toBeNull();
    const input = screen.getByLabelText('اليومية');
    fireEvent.input(input, { target: { value: 'ا'.repeat(85) } });
    const count = container.querySelector('.field-count');
    expect(count?.textContent).toMatch(/85\s*\/\s*100/);
    expect(input.getAttribute('aria-describedby')).toContain(count?.id ?? 'missing');
  });
});
