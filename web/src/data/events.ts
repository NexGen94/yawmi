import type { components } from '../api/schema';
import type { Day } from '../domain/types';
import { enqueue } from '../sync/outbox';

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
  return enqueue('habit_logged', payload);
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
  return enqueue('journal_saved', payload);
}

/**
 * Enqueue a mood logged event.
 */
export async function logMood(input: MoodLoggedPayload): Promise<string> {
  return enqueue('mood_logged', input as Record<string, unknown>);
}

/**
 * Enqueue a goal task completion toggle event.
 */
export async function setGoalTask(taskId: string, done: boolean): Promise<string> {
  return enqueue('goal_task_set', {
    task_id: taskId,
    done,
  });
}

/**
 * Enqueue a focus session started event.
 */
export async function startFocus(p: FocusStartedPayload): Promise<string> {
  return enqueue('focus_started', p as Record<string, unknown>);
}

/**
 * Enqueue a focus session ended event.
 */
export async function endFocus(p: FocusEndedPayload): Promise<string> {
  return enqueue('focus_ended', p as Record<string, unknown>);
}

/**
 * Enqueue a breath session ended event.
 */
export async function endBreath(p: BreathEndedPayload): Promise<string> {
  return enqueue('breath_ended', p as Record<string, unknown>);
}
