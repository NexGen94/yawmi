// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { Card } from '../../src/ui/Card';
import { CheckRow } from '../../src/ui/CheckRow';
import { Chips } from '../../src/ui/Chips';
import { Dialog } from '../../src/ui/Dialog';
import { Disclosure } from '../../src/ui/Disclosure';
import { Drawer } from '../../src/ui/Drawer';
import { Field } from '../../src/ui/Field';
import { HeroCard } from '../../src/ui/HeroCard';
import { Segmented } from '../../src/ui/Segmented';
import { Skeleton } from '../../src/ui/Skeleton';
import { Slider } from '../../src/ui/Slider';
import { StateFrame } from '../../src/ui/StateFrame';
import { Toast } from '../../src/ui/Toast';

const styles = resolve(import.meta.dirname, '..', '..', 'src', 'styles');
const css = (name: string): string => readFileSync(join(styles, name), 'utf8');

/** Loads the real tokens and component styles into the document, so computed sizes come from
 *  the stylesheets the app ships (happy-dom resolves var()). */
function withStyles(): void {
  const style = document.createElement('style');
  style.textContent = css('tokens.css') + '\n' + css('components.css');
  document.head.append(style);
}

describe('StateFrame', () => {
  const noop = (): void => undefined;

  it('loading: busy, a hidden status for screen readers, skeletons, and no content', () => {
    const { container } = render(
      <StateFrame state="loading" emptyText="لا عادات بعد" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    const frame = container.firstElementChild;
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('جارٍ التحميل');
    expect(container.querySelector('.skeleton')).toBeTruthy();
    expect(screen.queryByText('المحتوى')).toBeNull();
  });

  it('loading uses the skeleton the page passes, sized like its content', () => {
    const { container } = render(
      <StateFrame state="loading" emptyText="أ" onRetry={noop} skeleton={<Skeleton blockSize="120px" />}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons).toHaveLength(1);
    expect((skeletons[0] as HTMLElement).style.blockSize).toBe('120px');
  });

  it('ready: the content, not busy', () => {
    const { container } = render(
      <StateFrame state="ready" emptyText="لا عادات بعد" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(screen.getByText('المحتوى')).toBeTruthy();
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('false');
  });

  it('empty: the sentence that says what is missing and the action that fills it', () => {
    render(
      <StateFrame
        state="ready"
        empty
        emptyText="لا عادات بعد."
        emptyAction={<Button variant="primary">عادة جديدة</Button>}
        onRetry={noop}
      >
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(screen.getByText('لا عادات بعد.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'عادة جديدة' })).toBeTruthy();
    expect(screen.queryByText('المحتوى')).toBeNull();
  });

  it('error: «تعذّر التحميل» in an alert region and «إعادة المحاولة», which calls onRetry once', () => {
    const onRetry = vi.fn();
    render(
      <StateFrame state="error" emptyText="أ" onRetry={onRetry}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(screen.getByRole('alert').textContent).toContain('تعذّر التحميل');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('المحتوى')).toBeNull();
  });

  it('offline with a saved copy: the copy with the badge «نسخة محفوظة · بلا اتصال»', () => {
    render(
      <StateFrame state="offline" stale emptyText="أ" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(screen.getByText('المحتوى')).toBeTruthy();
    expect(screen.getByText('نسخة محفوظة · بلا اتصال')).toBeTruthy();
  });

  it('offline without a saved copy: «لا نسخة محفوظة بعد»', () => {
    render(
      <StateFrame state="offline" emptyText="أ" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(screen.getByText('لا نسخة محفوظة بعد')).toBeTruthy();
    expect(screen.queryByText('المحتوى')).toBeNull();
  });

  it('keeps the same outer element from loading to ready, so nothing remounts or jumps', () => {
    withStyles();
    const { container, rerender } = render(
      <StateFrame state="loading" emptyText="أ" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    const before = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(before).getPropertyValue('display')).toBe('flow-root');
    rerender(
      <StateFrame state="ready" emptyText="أ" onRetry={noop}>
        <p>المحتوى</p>
      </StateFrame>,
    );
    expect(container.firstElementChild).toBe(before);
  });
});

describe('Button', () => {
  it('is a real button, type="button" unless told otherwise, in the primary and quiet variants', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button variant="primary" onClick={onClick}>
          حفظ الصباح
        </Button>
        <Button>إلغاء</Button>
        <Button type="submit">إرسال</Button>
      </>,
    );
    const primary = screen.getByRole('button', { name: 'حفظ الصباح' });
    expect(primary.getAttribute('type')).toBe('button');
    expect(primary.className).toContain('btn-primary');
    expect(screen.getByRole('button', { name: 'إلغاء' }).className).toContain('btn-quiet');
    expect(screen.getByRole('button', { name: 'إرسال' }).getAttribute('type')).toBe('submit');
    fireEvent.click(primary);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('primary and quiet are at least 44px tall, from --hit', () => {
    withStyles();
    render(
      <>
        <Button variant="primary">بارز</Button>
        <Button variant="quiet">هادئ</Button>
      </>,
    );
    for (const name of ['بارز', 'هادئ']) {
      expect(getComputedStyle(screen.getByRole('button', { name })).getPropertyValue('min-block-size')).toBe('44px');
    }
  });

  it('keeps the disabled look inside Dialog, Drawer, HeroCard and .on-ink', () => {
    withStyles();
    render(
      <>
        <HeroCard title="بطاقة بارزة">
          <Button variant="primary">بارز مفعّل في البطاقة</Button>
          <Button variant="primary" disabled>
            بارز معطّل في البطاقة
          </Button>
          <Button variant="quiet">هادئ مفعّل في البطاقة</Button>
          <Button variant="quiet" disabled>
            هادئ معطّل في البطاقة
          </Button>
        </HeroCard>
        <div class="on-ink">
          <Button variant="primary" disabled>
            بارز معطّل على الحبر
          </Button>
          <Button variant="quiet" disabled>
            هادئ معطّل على الحبر
          </Button>
        </div>
        <Dialog open title="حوار" onClose={() => undefined}>
          <Button variant="primary">بارز مفعّل في الحوار</Button>
          <Button variant="primary" disabled>
            بارز معطّل في الحوار
          </Button>
          <Button variant="quiet">هادئ مفعّل في الحوار</Button>
          <Button variant="quiet" disabled>
            هادئ معطّل في الحوار
          </Button>
        </Dialog>
        <Drawer open title="درج" onClose={() => undefined}>
          <Button variant="primary" disabled>
            بارز معطّل في الدرج
          </Button>
          <Button variant="quiet" disabled>
            هادئ معطّل في الدرج
          </Button>
        </Drawer>
      </>,
    );

    const disabledNames = [
      'بارز معطّل في البطاقة',
      'هادئ معطّل في البطاقة',
      'بارز معطّل على الحبر',
      'هادئ معطّل على الحبر',
      'بارز معطّل في الحوار',
      'هادئ معطّل في الحوار',
      'بارز معطّل في الدرج',
      'هادئ معطّل في الدرج',
    ];
    for (const name of disabledNames) {
      const btn = screen.getByRole('button', { name, hidden: true });
      const style = getComputedStyle(btn);
      expect(style.getPropertyValue('background'), name).toBe('#DCEFEF');
      expect(style.getPropertyValue('color'), name).toBe('#3B6A89');
      expect(style.getPropertyValue('border-color'), name).toBe('transparent');
      expect(style.getPropertyValue('cursor'), name).toBe('not-allowed');
    }

    expect(
      getComputedStyle(screen.getByRole('button', { name: 'بارز مفعّل في الحوار', hidden: true })).getPropertyValue('background'),
    ).toBe('#1D3557');
    expect(
      getComputedStyle(screen.getByRole('button', { name: 'بارز مفعّل في البطاقة', hidden: true })).getPropertyValue('background'),
    ).toBe('#F1FAEE');
  });
});

describe('every control meets the 44px target', () => {
  beforeEach(withStyles);

  it('check rows, segments, chips, fields, sliders, disclosures, dialog close and toast actions', () => {
    render(
      <>
        <CheckRow checked={false} label="قراءة" onToggle={() => undefined} />
        <Segmented
          label="العرض"
          options={[
            { value: 'a', label: 'اليوم' },
            { value: 'b', label: 'الأسبوع' },
          ]}
          value="a"
          onChange={() => undefined}
        />
        <Chips label="المشاعر" options={[{ value: 'calm', label: 'هادئ' }]} selected={[]} onChange={() => undefined} />
        <Field label="العنوان" value="" onInput={() => undefined} />
        <Slider label="الهدوء" min={1} max={10} value={5} onChange={() => undefined} />
        <Disclosure summary="التفاصيل">نص</Disclosure>
        <Toast message="أُرسل التسجيل" action={{ label: 'تراجع', onAction: () => undefined }} />
      </>,
    );
    const controls = [
      screen.getByRole('button', { name: 'قراءة' }),
      ...screen.getAllByRole('radio'),
      screen.getByRole('button', { name: 'هادئ' }),
      screen.getByLabelText('العنوان'),
      screen.getByRole('slider', { name: 'الهدوء' }),
      screen.getByText('التفاصيل').closest('summary') as HTMLElement,
      screen.getByRole('button', { name: 'تراجع' }),
    ];
    for (const el of controls) {
      expect(getComputedStyle(el).getPropertyValue('min-block-size'), el.outerHTML).toBe('44px');
    }
  });

  it('the dialog close button', () => {
    render(
      <Dialog open title="حوار" onClose={() => undefined}>
        نص
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'إغلاق' });
    expect(getComputedStyle(close).getPropertyValue('min-block-size')).toBe('44px');
    expect(getComputedStyle(close).getPropertyValue('min-inline-size')).toBe('44px');
  });
});

describe('CheckRow', () => {
  it('is a toggle button: aria-pressed, named by its label, described by its note and badge', () => {
    const onToggle = vi.fn();
    render(<CheckRow checked={false} label="المشي" note="بعد الاستيقاظ" badge={<Badge tone="signal">متأخر</Badge>} onToggle={onToggle} />);
    const row = screen.getByRole('button', { name: 'المشي' });
    expect(row.getAttribute('aria-pressed')).toBe('false');
    const describedIds = (row.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(describedIds).toHaveLength(2);
    const describedText = describedIds.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(describedText).toContain('بعد الاستيقاظ');
    expect(describedText).toContain('متأخر');
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('announces its badge via aria-describedby even when there is no note', () => {
    render(<CheckRow checked={false} label="قراءة 20 صفحة" badge={<Badge>O1</Badge>} onToggle={() => undefined} />);
    const row = screen.getByRole('button', { name: 'قراءة 20 صفحة' });
    const describedId = row.getAttribute('aria-describedby') ?? '';
    expect(describedId).not.toBe('');
    expect(document.getElementById(describedId)?.textContent).toBe('O1');
  });

  it('visually distinguishes a disabled row from an enabled one', () => {
    expect(css('components.css')).toMatch(/\.check-row:disabled\s*\{[^}]*color:\s*var\(--c-ink-2\)/);
    expect(css('components.css')).toMatch(/\.check-row:disabled\s+\.check-mark\s*\{[^}]*background:\s*var\(--c-blue-pale\)/);
  });

  it('done shows a drawn check mark, not a colour alone', () => {
    const { container, rerender } = render(<CheckRow checked={false} label="المشي" onToggle={() => undefined} />);
    expect(container.querySelector('.check-mark path')).toBeNull();
    rerender(<CheckRow checked label="المشي" onToggle={() => undefined} />);
    expect(screen.getByRole('button', { name: 'المشي' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.check-mark path')).toBeTruthy();
  });

  it('a pressed row turns off with false', () => {
    const onToggle = vi.fn();
    render(<CheckRow checked label="المشي" onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'المشي' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('reads its hint aloud with the row and never draws it: a visually hidden span named by aria-describedby', () => {
    render(<CheckRow checked label="المشي" hint="التسجيل لم يُرسل بعد؛ النقر يتراجع عنه" onToggle={() => undefined} />);
    const row = screen.getByRole('button', { name: 'المشي' });
    const ids = (row.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids).toHaveLength(1);
    const hint = document.getElementById(ids[0] ?? '');
    expect(hint?.textContent).toBe('التسجيل لم يُرسل بعد؛ النقر يتراجع عنه');
    expect(hint?.classList.contains('visually-hidden')).toBe(true);
  });

  it('describes the note, the hint and the badge together, in that order', () => {
    render(<CheckRow checked={false} label="المشي" note="بعد الاستيقاظ" hint="تلميح" badge={<Badge>O1</Badge>} onToggle={() => undefined} />);
    const row = screen.getByRole('button', { name: 'المشي' });
    const text = (row.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join('|');
    expect(text).toBe('بعد الاستيقاظ|تلميح|O1');
  });

  it('adds no description for a hint that is not given', () => {
    render(<CheckRow checked={false} label="المشي" onToggle={() => undefined} />);
    expect(screen.getByRole('button', { name: 'المشي' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('a note may be markup, not only text', () => {
    render(<CheckRow checked={false} label="المشي" note={<span class="lead">جملة</span>} onToggle={() => undefined} />);
    expect(document.querySelector('.check-note .lead')?.textContent).toBe('جملة');
  });
});

describe('Segmented', () => {
  const options = [
    { value: 'day', label: 'اليوم' },
    { value: 'week', label: 'الأسبوع' },
    { value: 'cycle', label: 'الدورة' },
  ];

  function Harness(props: { start?: string }) {
    const [value, setValue] = useState(props.start ?? 'day');
    return (
      <div dir="rtl">
        <Segmented label="المدى" options={options} value={value} onChange={setValue} />
      </div>
    );
  }

  it('is a radio group with one tab stop on the selected option', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'المدى' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('click selects', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'الدورة' }));
    expect(screen.getByRole('radio', { name: 'الدورة' }).getAttribute('aria-checked')).toBe('true');
  });

  it('arrow keys follow the visual direction in RTL, wrap, and move focus with the selection', () => {
    render(<Harness />);
    const first = screen.getByRole('radio', { name: 'اليوم' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    const week = screen.getByRole('radio', { name: 'الأسبوع' });
    expect(week.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(week);

    fireEvent.keyDown(week, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'اليوم' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'اليوم' }), { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'الدورة' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'الدورة' }), { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'اليوم' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'اليوم' }), { key: 'End' });
    expect(screen.getByRole('radio', { name: 'الدورة' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'الدورة' }), { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'اليوم' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Chips', () => {
  it('a group of toggle buttons that report the new selection', () => {
    const onChange = vi.fn();
    render(
      <Chips
        label="المشاعر"
        options={[
          { value: 'calm', label: 'هدوء' },
          { value: 'tired', label: 'تعب' },
        ]}
        selected={['calm']}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('group', { name: 'المشاعر' })).toBeTruthy();
    const calm = screen.getByRole('button', { name: 'هدوء' });
    const tired = screen.getByRole('button', { name: 'تعب' });
    expect(calm.getAttribute('aria-pressed')).toBe('true');
    expect(tired.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tired);
    expect(onChange).toHaveBeenLastCalledWith(['calm', 'tired']);
    fireEvent.click(calm);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe('Field', () => {
  it.each(['text', 'number', 'date', 'time'] as const)('renders a labelled %s input', (type) => {
    render(<Field label="القيمة" type={type} value="" onInput={() => undefined} />);
    expect((screen.getByLabelText('القيمة') as HTMLInputElement).type).toBe(type);
  });

  it('reports the typed value', () => {
    const onInput = vi.fn();
    render(<Field label="العنوان" value="" onInput={onInput} />);
    fireEvent.input(screen.getByLabelText('العنوان'), { target: { value: 'قراءة' } });
    expect(onInput).toHaveBeenCalledWith('قراءة');
  });

  it('describes the input by its hint and its error, and marks it invalid', () => {
    render(<Field label="الهدف" type="number" value="0" hint="مرة في اليوم" error="القيمة أكبر من صفر" onInput={() => undefined} />);
    const input = screen.getByLabelText('الهدف');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain('مرة في اليوم');
    expect(described).toContain('القيمة أكبر من صفر');
  });

  it('a multiline field is a labelled textarea', () => {
    render(<Field label="اليومية" multiline value="" onInput={() => undefined} />);
    expect(screen.getByLabelText('اليومية').tagName).toBe('TEXTAREA');
  });

  it('the input border carries meaning, so it is --c-blue, and disabled fields have a distinct surface', () => {
    expect(css('components.css')).toMatch(/\.field-input\s*\{[^}]*border:\s*1px solid var\(--c-blue\)/);
    expect(css('components.css')).toMatch(/\.field-input:disabled\s*\{[^}]*background:\s*var\(--c-blue-pale\)/);
  });
});

describe('Slider', () => {
  function Harness(props: { onChange: (v: number) => void }) {
    const [value, setValue] = useState(5);
    return (
      <div dir="rtl">
        <Slider
          label="الهدوء"
          min={1}
          max={10}
          value={value}
          onChange={(v) => {
            setValue(v);
            props.onChange(v);
          }}
        />
      </div>
    );
  }

  it('moves with the arrow keys: up and visual left raise it in RTL, down and right lower it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'الهدوء' });
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(7);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(5);
  });

  it('Home and End go to the ends, and the value never leaves the range', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'الهدوء' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(10);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('shows its value as text next to the label', () => {
    render(<Harness onChange={() => undefined} />);
    expect(screen.getByText('5')).toBeTruthy();
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          فتح
        </button>
        <Dialog open={open} title="تأكيد الإغلاق" onClose={() => setOpen(false)}>
          <button type="button">أول</button>
          <button type="button">ثانٍ</button>
        </Dialog>
      </>
    );
  }

  function open(): HTMLElement {
    const opener = screen.getByRole('button', { name: 'فتح' });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  }

  it('is a labelled modal dialog that takes the focus when it opens', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    const dialog = screen.getByRole('dialog', { name: 'تأكيد الإغلاق' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'أول' }));
  });

  it('traps Tab and Shift+Tab inside', () => {
    render(<Harness />);
    open();
    const close = screen.getByRole('button', { name: 'إغلاق' });
    const first = screen.getByRole('button', { name: 'أول' });
    const dialog = screen.getByRole('dialog');
    const focusables = [...dialog.querySelectorAll('button')];
    const last = focusables[focusables.length - 1] as HTMLElement;
    const head = focusables[0] as HTMLElement;
    expect(focusables).toContain(close);
    expect(focusables).toContain(first);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(head);

    head.focus();
    fireEvent.keyDown(head, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls the focus back if it escapes', () => {
    render(<Harness />);
    const opener = open();
    opener.focus();
    fireEvent.focusIn(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('closes with Escape and returns the focus to what opened it', () => {
    render(<Harness />);
    const opener = open();
    expect(opener.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener.hasAttribute('inert')).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  });

  it('with no field in its content, focuses the first action, not the close button', () => {
    render(
      <Dialog open title="إغلاق اليوم" onClose={() => undefined} actions={<Button variant="primary">إغلاق اليوم</Button>}>
        <p>نص فقط</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'إغلاق اليوم' }));
  });

  it('closes with its close button and returns the focus', () => {
    render(<Harness />);
    const opener = open();
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes when clicking the backdrop and returns the focus', () => {
    const { container } = render(<Harness />);
    const opener = open();
    const backdrop = container.querySelector('[data-layer-backdrop]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('skips roving tabindex="-1" radios and controls inside closed Disclosure when trapping Tab', () => {
    render(
      <Dialog open title="خيارات" onClose={() => undefined}>
        <Segmented
          label="المدى"
          options={[
            { value: 'day', label: 'اليوم' },
            { value: 'week', label: 'الأسبوع' },
          ]}
          value="day"
          onChange={() => undefined}
        />
        <Disclosure summary="تفاصيل إضافية">
          <button type="button">زر مخفي</button>
        </Disclosure>
      </Dialog>,
    );
    const closeBtn = screen.getByRole('button', { name: 'إغلاق' });
    const dayRadio = screen.getByRole('radio', { name: 'اليوم' });
    const summary = screen.getByText('تفاصيل إضافية').closest('summary') as HTMLElement;
    expect(document.activeElement).toBe(dayRadio);

    summary.focus();
    fireEvent.keyDown(summary, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);

    closeBtn.focus();
    fireEvent.keyDown(closeBtn, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(summary);
  });
});

describe('Drawer', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          اسأل
        </button>
        <Drawer open={open} title="اسأل" onClose={() => setOpen(false)}>
          <label>
            السؤال
            <input />
          </label>
        </Drawer>
      </>
    );
  }

  it('traps the focus, locks scroll and marks background inert, closes with Escape and gives the focus back', () => {
    withStyles();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'اسأل' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole('dialog', { name: 'اسأل' });
    expect(getComputedStyle(drawer).getPropertyValue('block-size')).toBe('100%');
    expect(getComputedStyle(drawer).getPropertyValue('max-block-size')).toBe('100%');
    expect(opener.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.activeElement).toBe(screen.getByLabelText('السؤال'));
    const items = [...drawer.querySelectorAll<HTMLElement>('button, input')];
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener.hasAttribute('inert')).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);
  });
});

describe('Escape closes only the topmost layer', () => {
  it('a dialog opened inside a drawer makes the drawer inert and closes first', () => {
    const closeDrawer = vi.fn();
    const closeDialog = vi.fn();
    const { container } = render(
      <Drawer open title="اسأل" onClose={closeDrawer}>
        <button type="button">زر الدرج</button>
        <Dialog open title="تأكيد" onClose={closeDialog}>
          <button type="button">نعم</button>
        </Dialog>
      </Drawer>,
    );
    const drawerHead = container.querySelector('.drawer > .layer-head') as HTMLElement;
    expect(drawerHead.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('button', { name: 'زر الدرج', hidden: true }).hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('button', { name: 'نعم' }).hasAttribute('inert')).toBe(false);
    fireEvent.keyDown(screen.getByRole('button', { name: 'نعم' }), { key: 'Escape' });
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  it('announces politely and offers its action', () => {
    const onAction = vi.fn();
    render(<Toast message="أُرسل التسجيل" action={{ label: 'تراجع', onAction }} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('أُرسل التسجيل');
    fireEvent.click(screen.getByRole('button', { name: 'تراجع' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed when it has onDismiss', () => {
    const onDismiss = vi.fn();
    render(<Toast message="حُفظت العادة" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('Disclosure', () => {
  it('is a native details element: closed by default, open on request', () => {
    const { container, rerender } = render(<Disclosure summary="التفاصيل">النص الكامل</Disclosure>);
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain('التفاصيل');
    rerender(
      <Disclosure summary="التفاصيل" defaultOpen>
        النص الكامل
      </Disclosure>,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });
});

describe('Skeleton, Badge, Card, HeroCard', () => {
  it('Skeleton is hidden from assistive technology and takes logical sizes', () => {
    const { container } = render(<Skeleton blockSize="22px" inlineSize="40%" />);
    const el = container.querySelector('.skeleton') as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.blockSize).toBe('22px');
    expect(el.style.inlineSize).toBe('40%');
  });

  it('Badge carries its meaning in text; the signal tone adds a drawn dot, not a colour alone', () => {
    const { container } = render(
      <>
        <Badge>O1</Badge>
        <Badge tone="signal">متأخر</Badge>
      </>,
    );
    expect(screen.getByText('O1')).toBeTruthy();
    const late = screen.getByText('متأخر').closest('.badge');
    expect(late?.className).toContain('badge-signal');
    expect(late?.querySelector('.badge-dot')).toBeTruthy();
    expect(container.querySelectorAll('.badge')).toHaveLength(2);
  });

  it('Card and HeroCard with a title are regions named by their heading', () => {
    render(
      <>
        <Card title="إدخالات اليوم">نص</Card>
        <HeroCard title="إنجاز اليوم">نص</HeroCard>
      </>,
    );
    expect(screen.getByRole('region', { name: 'إدخالات اليوم' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'إنجاز اليوم' }).className).toContain('hero-card');
    expect(screen.getByRole('heading', { name: 'إدخالات اليوم' }).tagName).toBe('H2');
  });

  it('a Card heading level can be set', () => {
    render(
      <Card title="المحطات" headingLevel={3}>
        نص
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'المحطات' }).tagName).toBe('H3');
  });
});

describe('components.css', () => {
  const sheet = css('components.css');
  const outside = sheet.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/.exec(sheet)?.[1] ?? '';

  it('shows focus with the --focus ring, --focus-on-ink on ink surfaces, and restores --focus inside a dialog or drawer', () => {
    expect(sheet).toMatch(/:focus-visible[^{]*\{[^}]*box-shadow:\s*var\(--focus\)/);
    expect(sheet).toMatch(/\.hero-card[^{]*:focus-visible[^{]*\{[^}]*box-shadow:\s*var\(--focus-on-ink\)/);
    expect(sheet).toMatch(/\.on-ink[^{]*:focus-visible[^{]*\{[^}]*box-shadow:\s*var\(--focus-on-ink\)/);
    expect(sheet).toMatch(/:where\(\.dialog,\s*\.drawer\)\s+:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus\)/);
  });

  it('pins Drawer to full block-size, reserves scrollbar-gutter: stable on :root, and keeps a single scroll-lock mechanism', () => {
    expect(sheet).toMatch(/\.drawer\s*\{[^}]*block-size:\s*100%;[^}]*max-block-size:\s*100%;/s);
    expect(sheet).toMatch(/\.dialog\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(sheet).toMatch(/\.drawer\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(sheet).toMatch(/\.layer\s*\{[^}]*overscroll-behavior:\s*contain;/s);
    expect(sheet).toMatch(/:root\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
    expect(sheet).not.toMatch(/:has\(\.layer\)/);
  });

  it('never restyles a button under Dialog, Drawer, HeroCard or .on-ink without excluding :disabled', () => {
    const unguardedScopedButtonRules = (cssText: string): string[] => {
      const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
      const offenders: string[] = [];
      for (const [, rawSelector] of stripped.matchAll(/([^{}@]+)\{[^}]*\}/g)) {
        const selector = (rawSelector ?? '').trim();
        if (
          /(?:\.dialog|\.drawer|\.hero-card|\.on-ink)\b[^{]*\s+[^{]*(?:\.btn(?:-[\w-]+)?|\bbutton\b)/.test(selector) &&
          !selector.includes(':not(:disabled)') &&
          !selector.includes(':disabled')
        ) {
          offenders.push(selector);
        }
      }
      return offenders;
    };

    expect(unguardedScopedButtonRules(outside)).toEqual([]);
    expect(unguardedScopedButtonRules(`${outside}\n.dialog .btn-primary { background: var(--c-ink); }`)).toHaveLength(1);
    expect(unguardedScopedButtonRules(`${outside}\n.drawer .btn-quiet { background: var(--c-surface); }`)).toHaveLength(1);
    expect(unguardedScopedButtonRules(`${outside}\n.hero-card .btn-primary { background: var(--c-bg); }`)).toHaveLength(1);
    expect(unguardedScopedButtonRules(`${outside}\n.on-ink .btn-quiet { color: var(--c-bg); }`)).toHaveLength(1);
  });

  it('gives a pressed Chip on ink a visible shape distinct from the --c-ink ground', () => {
    expect(sheet).toMatch(
      /:is\(\.hero-card,\s*\.on-ink\)\s+\.chip\[aria-pressed='true'\]\s*\{[^}]*border-color:\s*var\(--c-blue-light\);[^}]*background:\s*var\(--c-ink-2\);/s,
    );
    expect(sheet).toMatch(
      /:is\(\.dialog,\s*\.drawer\)\s+\.chip\[aria-pressed='true'\]\s*\{[^}]*border-color:\s*var\(--c-ink\);[^}]*background:\s*var\(--c-ink\);/s,
    );

    withStyles();
    render(
      <div class="on-ink">
        <Chips
          label="المشاعر"
          options={[
            { value: 'calm', label: 'هدوء' },
            { value: 'tired', label: 'تعب' },
          ]}
          selected={['calm']}
          onChange={() => undefined}
        />
      </div>,
    );
    const pressed = getComputedStyle(screen.getByRole('button', { name: 'هدوء' }));
    expect(pressed.getPropertyValue('background')).not.toBe('#1D3557');
    expect(pressed.getPropertyValue('border-color')).not.toBe('#1D3557');
    expect(pressed.getPropertyValue('background')).toBe('#3B6A89');
    expect(pressed.getPropertyValue('border-color')).toBe('#A8DADC');
  });

  it('provides on-ink variants for WeekBars, Sparkline, Heatmap, Disclosure, and secondary text inside HeroCard and .on-ink', () => {
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+\.bars-bar\s*\{[^}]*fill:\s*var\(--c-blue-light\)/);
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+\.bars-latest\s*\{[^}]*fill:\s*var\(--c-bg\)/);
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+\.bars-value\s*\{[^}]*fill:\s*var\(--c-bg\)/);
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+\.spark-line\s*\{[^}]*stroke:\s*var\(--c-blue-light\)/);
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+\.disclosure-chevron\s*\{[^}]*color:\s*var\(--c-blue-light\)/);
    expect(sheet).toMatch(/:is\(\.hero-card,\s*\.on-ink\)\s+:is\([^)]*\.check-note[^)]*\)\s*\{[^}]*color:\s*var\(--c-blue-light\)/);
  });

  it('never redefines .num or .num-lg outside index.css', () => {
    const hasNumRule = (cssText: string): boolean => /(?:^|[},])\s*\.num(?:-lg)?(?![\w-])\s*[,{]/m.test(cssText);
    expect(hasNumRule(sheet)).toBe(false);
    expect(hasNumRule(`${sheet}\n.num { font-size: 12px; }`)).toBe(true);
    expect(hasNumRule(`${sheet}\n.num-lg { font-size: 24px; }`)).toBe(true);
  });

  it('every animated or transitioning rule is stilled under prefers-reduced-motion', () => {
    expect(reduced).not.toBe('');
    const moving: string[] = [];
    for (const [, selector, body] of outside.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/\b(animation|transition)\s*:/.test(body ?? '') && !/:\s*none\b/.test(/(animation|transition)\s*:[^;]*/.exec(body ?? '')?.[0] ?? '')) {
        for (const part of (selector ?? '').split(',')) {
          const cls = /\.[\w-]+/.exec(part)?.[0];
          if (cls) moving.push(cls);
        }
      }
    }
    expect(moving.length).toBeGreaterThan(0);
    for (const cls of moving) expect(reduced, cls).toContain(cls);
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
  });
});

afterEach(() => {
  document.head.querySelectorAll('style').forEach((style) => style.remove());
});
