import { Card } from '../../ui/Card';

// The keys of design section 3 (`lib/keys.ts` installs them). Matched on the physical key, so they
// work on the Arabic layout too.
const SHORTCUTS: readonly { keys: string[]; sequence?: boolean; does: string }[] = [
  { keys: ['Ctrl+K'], does: 'اسأل، من أي مكان' },
  { keys: ['/'], does: 'اسأل، خارج الحقول' },
  { keys: ['G', 'H'], sequence: true, does: 'الرئيسية' },
  { keys: ['G', 'D'], sequence: true, does: 'اليوم' },
  { keys: ['G', 'A'], sequence: true, does: 'العادات' },
  { keys: ['G', 'O'], sequence: true, does: 'الأهداف' },
];

/** «الاختصارات»: what the keyboard does. The keys are Latin letters and stay left to right. */
export function ShortcutsSection() {
  return (
    <Card title="الاختصارات" class="settings-card">
      <dl class="shortcuts">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.does} class="shortcut">
            <dt>
              {shortcut.keys.map((key, i) => (
                <span key={key}>
                  {i > 0 && ' ثم '}
                  <kbd dir="ltr">{key}</kbd>
                </span>
              ))}
            </dt>
            <dd>{shortcut.does}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
