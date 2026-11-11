import { lazy, LocationProvider, Route, Router } from 'preact-iso';

import HomePage from './pages/home';
import { AppShell, focusPageHeading } from './shell/AppShell';
import { NotFound } from './shell/NotFound';

// Every route of design section 3, registered once. The shell and the home page are in the first
// bundle; every other page is lazy() (scripts/check-budget.mjs fails if index.html loads one).
// Page tasks replace their page files and leave this one alone.
const DayPage = lazy(() => import('./pages/day'));
const HabitsPage = lazy(() => import('./pages/habits'));
const HabitEditorPage = lazy(() => import('./pages/habits/editor'));
const HabitDetailPage = lazy(() => import('./pages/habits/detail'));
const GoalsPage = lazy(() => import('./pages/goals'));
const GoalDetailPage = lazy(() => import('./pages/goals/detail'));
const ReviewPage = lazy(() => import('./pages/review'));
const FocusPage = lazy(() => import('./pages/focus'));
const BreathPage = lazy(() => import('./pages/breath'));
const AskPage = lazy(() => import('./pages/ask'));
const SettingsPage = lazy(() => import('./pages/settings'));
const PairPage = lazy(() => import('./pages/pair'));

export function App() {
  return (
    <LocationProvider>
      <AppShell>
        <Router onRouteChange={focusPageHeading}>
          <Route path="/" component={HomePage} />
          <Route path="/day" component={DayPage} />
          <Route path="/day/morning" component={DayPage} />
          <Route path="/day/evening" component={DayPage} />
          <Route path="/habits" component={HabitsPage} />
          <Route path="/habits/new" component={HabitEditorPage} />
          <Route path="/habits/:code" component={HabitDetailPage} />
          <Route path="/habits/:code/edit" component={HabitEditorPage} />
          <Route path="/goals" component={GoalsPage} />
          <Route path="/goals/:ref" component={GoalDetailPage} />
          <Route path="/review" component={ReviewPage} />
          <Route path="/focus" component={FocusPage} />
          <Route path="/breath" component={BreathPage} />
          <Route path="/ask" component={AskPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/pair" component={PairPage} />
          <Route default component={NotFound} />
        </Router>
      </AppShell>
    </LocationProvider>
  );
}
