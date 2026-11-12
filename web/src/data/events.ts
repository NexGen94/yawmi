import type { components } from '../api/schema';
import type { Day } from '../domain/types';
import { enqueue, scheduleFlush } from '../sync/outbox';

type MorningAnswers = components['schemas']['MorningAnswers'];
type EveningAnswers = components['schemas']['EveningAnswers'];
type MoodLoggedPayload = components['schemas']['MoodLoggedPayload'];
type FocusStartedPayload = components['schemas']['FocusStartedPayload'];
type FocusEndedPayload = components['schemas']['FocusEndedPayload'];
type BreathEndedPayload = components['schemas']['BreathEndedPayload'];

export interface LogHabitInput {
  status: 'done' | 'skip' | 'vacation';
  value?: number;
  day?: Day;
}

/**
 * Enqueue a habit logged event. If `value` is omitted, the payload omits the field.
 */
export async function logHabit(code: string, input: LogHabitInput): Promise<string> {
  const payload: Record<string, unknown> = {
    habit_code: code,
    status: input.status,
  };
  if (input.value !== undefined) {
    payload.value = input.value;
  }
  if (input.day !== undefined) {
    payload.day = input.day;
  }
  const id = await enqueue('habit_logged', payload);
  scheduleFlush();
  return id;
}

/**
 * Enqueue a journal saved event for morning or evening.
 */
export async function saveJournal(
  part: 'morning' | 'evening',
  answers: MorningAnswers | EveningAnswers,
  day?: Day,
): Promise<string> {
  const payload: Record<string, unknown> = {
    part,
    answers,
  };
  if (day !== undefined) {
    payload.day = day;
  }
  const id = await enqueue('journal_saved', payload);
  scheduleFlush();
  return id;
}

/**
 * Enqueue a mood logged event.
 */
export async function logMood(input: MoodLoggedPayload): Promise<string> {
  const id = await enqueue('mood_logged', input as Record<string, unknown>);
  scheduleFlush();
  return id;
}

/**
 * Enqueue a goal task completion toggle event.
 */
export async function setGoalTask(taskId: string, done: boolean): Promise<string> {
  const id = await enqueue('goal_task_set', {
    task_id: taskId,
    done,
  });
  scheduleFlush();
  return id;
}

/**
 * Enqueue a focus session started event.
 */
export async function startFocus(p: FocusStartedPayload): Promise<string> {
  const id = await enqueue('focus_started', p as Record<string, unknown>);
  scheduleFlush();
  return id;
}

/**
 * Enqueue a focus session ended event.
 */
export async function endFocus(p: FocusEndedPayload): Promise<string> {
  const id = await enqueue('focus_ended', p as Record<string, unknown>);
  scheduleFlush();
  return id;
}

/**
 * Enqueue a breath session ended event.
 */
export async function endBreath(p: BreathEndedPayload): Promise<string> {
  const id = await enqueue('breath_ended', p as Record<string, unknown>);
  scheduleFlush();
  return id;
}
