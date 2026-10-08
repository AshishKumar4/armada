/** How a job and its tasks stand, said the same way on every page. */
import type { JobBrief, Outcome } from '../../src/protocol';
import type { TaskState } from './charts';
import { count, h, pill, type Tone } from './dom';

type Tasks = JobBrief['tasks'];

/** A task's state from its one outcome. */
export function stateOf(outcome: Outcome): TaskState {
  if (outcome.kind === 'failed') return outcome.reason === 'cancelled' ? 'cancelled' : 'lost';

  if (outcome.reason === 'timeout') return 'timeout';

  return outcome.exitCode === 0 ? 'green' : 'red';
}

export const STATE_WORDS: Readonly<Record<TaskState, string>> = {
  queued: 'queued', running: 'running', green: 'green', red: 'red', timeout: 'timed out', lost: 'lost', cancelled: 'cancelled',
};

/** A job's pill: preparing, running, or done with how its tasks went. */
export function jobPill(brief: Pick<JobBrief, 'phase' | 'tasks' | 'problems'>): HTMLSpanElement {
  const { phase, tasks, problems } = brief;

  if (phase === 'preparing') return pill('idle', 'preparing');

  if (phase === 'running') return pill('live', 'running');
  const bad = tasks.red + tasks.failed;
  const cancelled = problems.some((problem) => problem.startsWith('cancelled'));
  const tone: Tone = bad === 0 ? 'ok' : cancelled ? 'warn' : 'bad';

  return pill(tone, cancelled ? 'cancelled' : bad === 0 ? 'done' : `${count(bad)} not green`);
}

/** A bar of the job's tasks: green, red, never finished, and running, over what is still queued. */
export function progress(tasks: Tasks, thick = false): HTMLDivElement {
  const total = Math.max(1, tasks.total);
  const part = (tone: string, value: number) => value === 0 ? null : h('span', { class: tone, style: { width: `${String((value / total) * 100)}%` } });

  return h('div', { class: `bar${thick ? ' thick' : ''}`, label: `${count(tasks.exited + tasks.failed)} of ${count(tasks.total)} tasks done` },
    part('ok', tasks.exited - tasks.red), part('bad', tasks.red), part('warn', tasks.failed), part('live', tasks.running));
}

/** The counts under a job's bar. */
export function counts(tasks: Tasks): HTMLDivElement {
  const word = (tone: string, value: number, label: string) => h('span', {}, h('span', { class: `dot ${tone}` }), h('b', {}, count(value)), label);

  return h('div', { class: 'counts' },
    word('ok', tasks.exited - tasks.red, 'green'), word('bad', tasks.red, 'red'), word('warn', tasks.failed, 'never finished'), word('live', tasks.running, 'running'),
    word('idle', tasks.queued, 'queued'));
}

/** A job's name: its label, else its id. */
export const nameOf = (brief: Pick<JobBrief, 'id' | 'label'>): string => brief.label === '' ? brief.id : brief.label;

/** How long a job took, or has taken so far. */
export const tookOf = (brief: Pick<JobBrief, 'createdAt' | 'finishedAt'>, now = Date.now()): number => (brief.finishedAt ?? now) - brief.createdAt;
