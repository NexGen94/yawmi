import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { shortName, sourceFiles } from './copy/words';

// Red has one meaning: an error or a failure that needs an action (controller ruling, Task 24).
// A pending edit, a saved copy and a missing connection are states, not failures: they are drawn
// in the blue-pale badge with --c-ink-2 text. Late habits and milestones keep their red (what
// needs attention in the plan), and a refused save or a refused code is an error.

const tsx = sourceFiles().filter((f) => f.endsWith('.tsx'));

describe('red is for failures and what needs attention, never for a state', () => {
  it('the files of the pending badge, the pending marks and the offline notes use no signal tone', () => {
    for (const file of ['pages/goals/PendingBadge.tsx', 'pages/goals/EditField.tsx', 'shell/ConnectionStatus.tsx', 'settings/saving.tsx']) {
      const code = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(code, file).not.toMatch(/tone="signal"|c-signal|badge-signal/);
    }
  });

  it('the pair notice has no red in its stylesheet, and the pair error keeps it', () => {
    const css = readFileSync(new URL('../src/pages/pair/pair.css', import.meta.url), 'utf8');
    const notice = /\.pair-notice\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(notice).toContain('--c-ink-2');
    expect(notice).not.toContain('signal');
    expect(/\.pair-error-text\s*\{([^}]*)\}/.exec(css)?.[1]).toContain('--c-signal-ink');
  });

  it('every use of the signal badge is about lateness (a habit, a milestone, the pace), listed here', () => {
    const uses = tsx.filter((f) => /tone="signal"/.test(readFileSync(f, 'utf8'))).map(shortName).sort();
    expect(uses).toEqual([
      'habits/HabitRow.tsx',
      'pages/goals/GoalsTable.tsx',
      'pages/goals/MilestoneList.tsx',
      'pages/goals/OutcomeTree.tsx',
      'pages/goals/detail.tsx',
      'pages/home/LateSection.tsx',
    ]);
  });
});

describe('the navy fill belongs to the one prominent button (Task 24, design review #3)', () => {
  it('a pressed toggle on the plans list of the focus page is a quiet button with a border, not a navy one', () => {
    const css = readFileSync(new URL('../src/pages/focus/focus.css', import.meta.url), 'utf8');
    const rule = css.split('}').map((b) => b.split('{')).find(([head]) => (head ?? '').includes(".focus-plan .btn[aria-pressed='true']"))?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).not.toContain('background: var(--c-ink)');
    expect(rule).toContain('box-shadow');
  });
});
