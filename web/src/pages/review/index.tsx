/// <reference types="vite/client" />
// (for the stylesheet import below: the test tsconfig does not load vite client types itself)

import { useLocation } from 'preact-iso';

import { useToday } from '../../goals/data';
import { Segmented } from '../../ui/Segmented';
import { JournalTimeline } from './JournalTimeline';
import { MoodTab } from './MoodTab';
import { WeeklyReview } from './WeeklyReview';
import './review.css';

type Tab = 'week' | 'journal' | 'mood';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'week', label: 'الأسبوع' },
  { value: 'journal', label: 'السجل' },
  { value: 'mood', label: 'المزاج' },
];

const parseTab = (raw: string | undefined): Tab => TABS.find((t) => t.value === raw)?.value ?? 'week';

/** `/review` (design 4): what happened this week, the journal of the days and the mood. The tab is
 *  written in `?tab=` so a link, a reload and the back button keep it. */
export default function ReviewPage() {
  const location = useLocation();
  const today = useToday();
  const tab = parseTab(location.query?.tab);

  return (
    <>
      <div class="review-head">
        <h1>المراجعة</h1>
        <Segmented label="القسم" options={TABS} value={tab} onChange={(next) => location.route(`/review?tab=${next}`, true)} />
      </div>
      {tab === 'week' && <WeeklyReview today={today} />}
      {tab === 'journal' && <JournalTimeline today={today} />}
      {tab === 'mood' && <MoodTab today={today} />}
    </>
  );
}
