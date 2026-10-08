/**
 * One job, followed live: its tasks as cells, its containers as rows of the tasks each ran, and any task opened in a
 * drawer with its item, its answer, the end of its log and its stored files. Outcomes are read once each, by sequence,
 * so a job of 100 000 tasks costs a poll only what landed since the last.
 */
import * as v from 'valibot';
import { EventsSchema, JobStatusSchema, JsonSchema, type JobStatus, type Json, type Outcome } from '../../src/protocol';
import { blob, get } from './api';
import { TaskGrid, Timeline, type Lane, type Segment, type TaskState } from './charts';
import { ago, bytes, count, duration, h, icon, pill, replace, save, when, type Tone } from './dom';
import { counts, jobPill, nameOf, progress, STATE_WORDS, stateOf, tookOf } from './status';
import { empty, poll, describe as said, type View } from './view';

interface Landed {
  readonly outcome: Outcome;
  readonly at?: number;
}

const VESSEL_TONES: Readonly<Record<JobStatus['vessels'][number]['state'], Tone>> = { waiting: 'idle', booting: 'live', working: 'live', done: 'idle', failed: 'bad' };

const KEY: readonly TaskState[] = ['queued', 'running', 'green', 'red', 'timeout', 'lost', 'cancelled'];

export function jobView(id: string, opened: number | null): View {
  const banner = h('div');
  const title = h('h1', {}, id);
  const pillSlot = h('div');
  const meta = h('div', { class: 'job-meta' });
  const summary = h('div', { class: 'summary' }, h('div', { class: 'skeleton' }));
  const vesselsBody = h('div', { class: 'vessels scroll-y' });
  const vesselsAside = h('span', { class: 'aside' });
  const tasksAside = h('span', { class: 'aside' });
  const problemsCard = h('div');
  const outcomes = new Map<number, Landed>();
  let status: JobStatus | null = null;
  let seq = 0;
  let items: Promise<readonly Json[]> | null = null;
  let drawer: (() => void) | null = null;

  const grid = new TaskGrid('every task of the job, as a cell coloured by how it stands', (index) => describeTask(index), (index) => { open(index); });
  const timeline = new Timeline('each container of the job, with the tasks it ran over time', (segment) => describeSegment(segment), (segment) => {
    if (segment.task !== null) open(segment.task);
  });

  const describeTask = (index: number): HTMLElement => {
    const landed = outcomes.get(index);
    const running = status?.running?.find((each) => each.index === index);
    const detail = landed !== undefined ? `${STATE_WORDS[stateOf(landed.outcome)]}${landed.outcome.cached === true ? ', from the cache' : ''} · ${duration(landed.outcome.seconds * 1000)}${landed.outcome.vessel === '' ? '' : ` on ${laneOf(landed.outcome.vessel, landed.outcome.slot)}`}`
      : running !== undefined ? `running on ${laneOf(running.vessel, running.slot)} for ${duration(Date.now() - running.started)}` : 'queued';

    return h('div', {}, h('b', {}, `Task ${count(index)}`), h('span', { class: 'muted' }, detail));
  };

  const describeSegment = (segment: Segment): HTMLElement => segment.task === null
    ? h('div', {}, h('b', {}, segment.lane), h('span', { class: 'muted' }, `starting, ${duration(segment.end - segment.start)}`))
    : h('div', {}, h('b', {}, `Task ${count(segment.task)} on ${segment.lane}`),
      h('span', { class: 'muted' }, `${STATE_WORDS[segment.state === 'boot' ? 'running' : segment.state]} · ${duration((segment.state === 'running' ? Date.now() : segment.end) - segment.start)}`));

  const element = h('div', { class: 'page' },
    h('div', {},
      h('a', { class: 'back', href: '#/' }, icon('back'), 'Fleet'),
      h('div', { class: 'page-head' }, h('div', {}, title, meta), pillSlot)),
    banner,
    h('section', { class: 'card' }, summary),
    h('div', { class: 'grid grid-job' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Tasks'), tasksAside),
        h('div', { class: 'card-body' }, grid.element, h('div', { class: 'key' }, KEY.map((state) => h('span', {}, h('span', { class: `swatch ${state}` }), STATE_WORDS[state]))))),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Containers'), vesselsAside), h('div', { class: 'card-body flush' }, vesselsBody))),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Timeline'), h('span', { class: 'aside' }, 'from the job\'s start')),
      h('div', { class: 'card-body' }, h('div', { class: 'scroll-y' }, timeline.element),
        h('div', { class: 'key' }, h('span', {}, h('span', { class: 'swatch boot' }), 'starting'), ['running', 'green', 'red', 'timeout', 'lost'].map((state) => h('span', {}, h('span', { class: `swatch ${state}` }), state))))),
    problemsCard);

  const render = (): void => {
    if (status === null) return;
    const now = Date.now();
    const name = nameOf(status);

    document.title = `${name} · armada`;
    replace(title, name);
    replace(pillSlot, jobPill(status));
    replace(meta,
      status.label === '' ? null : h('span', { class: 'mono' }, status.id),
      h('span', { title: when(status.createdAt) }, `made ${ago(status.createdAt, now)}`),
      h('span', {}, `took ${duration(tookOf(status, now))}`),
      status.startedAt === null ? null : h('span', { title: 'from the environment being ready to the last answer' }, `tasks ${duration((status.finishedAt ?? now) - status.startedAt)}`),
      h('span', { class: 'mono', title: status.environment === null ? 'not ready yet' : Object.entries(status.environment.seconds).map(([phase, seconds]) => `${phase} ${duration(seconds * 1000)}`).join(', ') },
        `environment ${status.key.slice(0, 12)}`));
    replace(summary, progress(status.tasks, true), counts(status.tasks));
    replace(tasksAside, `${count(status.tasks.total)} in all`);
    replace(vesselsAside, status.vessels.length === 0 ? '' : `${count(status.vessels.filter((vessel) => VESSEL_TONES[vessel.state] === 'live').length)} up of ${count(status.vessels.length)}`);
    replace(vesselsBody, status.vessels.length === 0
      ? empty(status.phase === 'preparing' ? 'Preparing the environment' : 'No container yet', status.phase === 'preparing' ? 'A new recipe is prepared once, in a few minutes; its containers start after.' : '')
      : status.vessels.map((vessel) => h('div', { class: 'vessel-row' },
        h('span', { class: `dot ${VESSEL_TONES[vessel.state]}` }), h('span', { class: 'mono' }, vessel.name),
        h('span', { class: 'muted num' }, `${count(vessel.tasks)} task${vessel.tasks === 1 ? '' : 's'}${vessel.busyMs > 0 ? ` · busy ${duration(vessel.busyMs)}` : ''}${vessel.bootMs === null ? '' : ` · up in ${duration(vessel.bootMs)}`}`),
        h('span', { class: 'faint' }, vessel.state),
        vessel.error === null ? null : h('span', { class: 'error' }, vessel.error))));
    replace(problemsCard, status.problems.length === 0 ? null : h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Problems')),
      h('div', { class: 'card-body' }, h('ul', { class: 'problems' }, status.problems.map((problem) => h('li', {}, problem))))));
    const running = new Set((status.running ?? []).map((each) => each.index));

    grid.update(Array.from({ length: status.tasks.total }, (_, index): TaskState => {
      const landed = outcomes.get(index);

      return landed !== undefined ? stateOf(landed.outcome) : running.has(index) ? 'running' : 'queued';
    }));
    const { lanes, placed } = segments(status, outcomes, now);

    timeline.update(lanes, placed, status.startedAt ?? status.createdAt, status.finishedAt ?? now, status.phase !== 'done');
  };

  const open = (index: number): void => {
    drawer?.();
    history.replaceState(null, '', `#/jobs/${id}/${String(index)}`);
    items ??= get(`/jobs/${id}/items`, v.object({ items: v.array(JsonSchema) })).then((answer) => answer.items);
    drawer = taskDrawer(id, index, outcomes.get(index) ?? null, status?.running?.find((each) => each.index === index) ?? null, items, () => {
      drawer = null;
      history.replaceState(null, '', `#/jobs/${id}`);
    });
  };

  const pollster = poll(1500, banner, async () => {
    status = await get(`/jobs/${id}`, JobStatusSchema);

    for (let more = true; more;) {
      const batch = await get(`/jobs/${id}/events?after=${String(seq)}`, EventsSchema);

      for (const event of batch.events) outcomes.set(event.outcome.index, { outcome: event.outcome, ...event.at === undefined ? {} : { at: event.at } });
      seq = batch.events.at(-1)?.seq ?? seq;
      more = batch.events.length > 0 && !batch.done;
    }
    render();

    if (opened !== null) {
      open(opened);
      opened = null;
    }

    // A job that ended is read once more and then held still.
    return status.phase !== 'done';
  });

  return {
    element,
    dispose: () => {
      pollster.stop();
      grid.dispose();
      timeline.dispose();
      drawer?.();
    },
  };
}

/** A container's lane, or one slot's of a container that runs several tasks at once. */
const laneOf = (vessel: string, slot: number | undefined): string => slot === undefined ? vessel : `${vessel} · ${String(slot)}`;

/** Every container's lanes (one, or one a slot it has run a task in), its start and every task it ran or runs, placed
 *  in time. A task answered before this Worker stamped outcomes has no place, nor does one answered from the cache. */
function segments(status: JobStatus, outcomes: ReadonlyMap<number, Landed>, now: number): { readonly lanes: Lane[]; readonly placed: Segment[] } {
  const tasks: Segment[] = [];
  const slots = new Map<string, Set<number>>();
  /** Each container's first task's start, where its start ends. */
  const firsts = new Map<string, number>();
  const place = (vessel: string, slot: number | undefined, segment: Omit<Segment, 'lane'>): void => {
    if (slot !== undefined) slots.set(vessel, (slots.get(vessel) ?? new Set()).add(slot));
    firsts.set(vessel, Math.min(segment.start, firsts.get(vessel) ?? Infinity));
    tasks.push({ ...segment, lane: laneOf(vessel, slot) });
  };

  for (const [index, { outcome, at }] of outcomes) {
    if (at === undefined || outcome.vessel === '' || outcome.cached === true) continue;
    place(outcome.vessel, outcome.slot, { task: index, start: at - outcome.seconds * 1000, end: at, state: stateOf(outcome) });
  }

  for (const running of status.running ?? []) place(running.vessel, running.slot, { task: running.index, start: running.started, end: now, state: 'running' });
  const from = status.startedAt ?? status.createdAt;
  const lanes: Lane[] = [];
  const starts: Segment[] = [];

  for (const vessel of status.vessels) {
    const names = [...slots.get(vessel.name) ?? []].sort((left, right) => left - right).map((slot) => laneOf(vessel.name, slot));
    const own = names.length === 0 ? [vessel.name] : names;
    const first = firsts.get(vessel.name);
    const boot = vessel.bootMs;

    lanes.push(...own.map((name): Lane => ({ name, state: vessel.state })));
    // A container's start ends where its first task begins, on each of its lanes.
    if (boot !== null && first !== undefined) starts.push(...own.map((lane): Segment => ({ lane, task: null, start: Math.max(from, first - boot), end: first, state: 'boot' })));
  }

  return { lanes, placed: [...starts, ...tasks] };
}

/** A task in a drawer: what it was given, how it ended, and its files. Answers the drawer's close. */
function taskDrawer(job: string, index: number, landed: Landed | null, running: { readonly vessel: string; readonly started: number; readonly slot?: number } | null, items: Promise<readonly Json[]>, closed: () => void): () => void {
  const previous = document.activeElement;
  const itemSlot = h('pre', { class: 'code' }, '…');
  const close = (): void => {
    backdrop.remove();
    panel.remove();
    document.removeEventListener('keydown', escape);

    if (previous instanceof HTMLElement) previous.focus();
    closed();
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && document.querySelector('.modal') === null) close();
  };
  const closer = h('button', { class: 'icon-button', type: 'button', label: 'Close', onclick: close }, icon('close'));
  const outcome = landed?.outcome;
  const state: TaskState = outcome === undefined ? running === null ? 'queued' : 'running' : stateOf(outcome);
  const tones: Readonly<Record<TaskState, Tone>> = { queued: 'idle', running: 'live', green: 'ok', red: 'bad', timeout: 'warn', lost: 'bad', cancelled: 'idle' };
  const fact = (term: string, value: string | null) => value === null ? null : h('div', {}, h('dt', {}, term), h('dd', {}, value));
  const files = outcome === undefined ? null : h('div', { class: 'button-row' },
    h('button', { class: 'button', type: 'button', onclick: () => { showLog(job, index); } }, icon('log'), 'Whole log'),
    outcome.output ? h('button', { class: 'button', type: 'button', onclick: () => { void download(`/jobs/${job}/tasks/${String(index)}/output`, `${job}-${String(index)}.out`); } }, icon('download'), 'Output') : null,
    outcome.artifacts === true ? h('button', { class: 'button', type: 'button', onclick: () => { void download(`/jobs/${job}/tasks/${String(index)}/artifacts`, `${job}-${String(index)}-artifacts.tar.gz`); } }, icon('download'), 'Artifacts') : null);
  const backdrop = h('div', { class: 'backdrop', onclick: close });
  const panel = h('aside', { class: 'drawer', label: `Task ${String(index)}` },
    h('div', { class: 'drawer-head' }, h('h2', {}, `Task ${count(index)}`), h('div', { class: 'button-row' }, pill(tones[state], STATE_WORDS[state]), closer)),
    h('div', { class: 'drawer-body' },
      outcome === undefined
        ? h('dl', { class: 'facts' }, fact('Container', running === null ? null : laneOf(running.vessel, running.slot)), fact('Running for', running === null ? null : duration(Date.now() - running.started)),
          running === null ? fact('State', 'queued: no container has taken it yet') : null)
        : h('dl', { class: 'facts' },
          fact('Exit code', outcome.kind === 'exited' ? String(outcome.exitCode) : null),
          fact('Took', duration(outcome.seconds * 1000)),
          fact('Container', outcome.vessel === '' ? null : laneOf(outcome.vessel, outcome.slot)),
          fact('Attempt', String(outcome.attempt)),
          fact('Landed', landed?.at === undefined ? null : when(landed.at)),
          fact('Peak memory', outcome.peakMemory === undefined ? null : bytes(outcome.peakMemory)),
          fact('CPU', outcome.cpuSeconds === undefined || outcome.seconds === 0 ? null : `${(outcome.cpuSeconds / outcome.seconds).toFixed(2)} cores on average`),
          fact('Error', outcome.error ?? null),
          fact('Answered', outcome.cached === true ? 'from the cache; nothing ran' : null)),
      h('div', {}, h('p', { class: 'section-label' }, 'Item'), itemSlot),
      outcome?.value === undefined ? null : h('div', {}, h('p', { class: 'section-label' }, 'Output'), h('pre', { class: 'code' }, outcome.value)),
      outcome === undefined || outcome.tail === '' ? null : h('div', {}, h('p', { class: 'section-label' }, 'End of its log'), h('pre', { class: 'code' }, outcome.tail)),
      files));

  document.body.append(backdrop, panel);
  document.addEventListener('keydown', escape);
  closer.focus();
  void items.then((all) => { replace(itemSlot, JSON.stringify(all[index] ?? null, null, 2)); }, (cause: unknown) => { replace(itemSlot, said(cause)); });

  return close;
}

async function download(path: string, name: string): Promise<void> {
  const found = await blob(path);

  if (found !== null) save(found, name);
}

/** A task's whole log, in a window over the page. */
function showLog(job: string, index: number): void {
  const body = h('pre', { class: 'code tall' }, 'Reading the log…');
  let text = '';
  const close = (): void => {
    modal.remove();
    shade.remove();
    document.removeEventListener('keydown', escape);
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const shade = h('div', { class: 'backdrop', onclick: close });
  const modal = h('div', { class: 'modal', label: `Task ${String(index)}'s log` },
    h('div', { class: 'drawer-head' }, h('h2', {}, `Task ${count(index)}'s log`), h('div', { class: 'button-row' },
      h('button', { class: 'button', type: 'button', onclick: () => { save(new Blob([text], { type: 'text/plain' }), `${job}-${String(index)}.log`); } }, icon('download'), 'Save'),
      h('button', { class: 'icon-button', type: 'button', label: 'Close', onclick: close }, icon('close')))),
    h('div', { class: 'drawer-body' }, body));

  document.body.append(shade, modal);
  document.addEventListener('keydown', escape);
  void blob(`/jobs/${job}/tasks/${String(index)}/log`).then(async (found) => {
    text = found === null ? '' : await found.text();
    replace(body, found === null ? 'This task kept no log: it never ran, or its log has expired (a job\'s files last 7 days).' : text === '' ? 'The task printed nothing.' : text);
    // A log ends with how its task ended, so it opens at its end.
    body.scrollTop = body.scrollHeight;
  }, (cause: unknown) => { replace(body, said(cause)); });
}
