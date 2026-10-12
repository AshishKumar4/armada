/**
 * One job, followed live: its tasks as cells, its containers as rows of the tasks each ran, and any task opened in a
 * drawer with its item, its answer, the end of its log and its stored files. Outcomes are read once each, by sequence,
 * so a job of 100 000 tasks costs a poll only what landed since the last.
 */
import * as v from 'valibot';
import { detach, EventsSchema, JobStatusSchema, JsonSchema, type JobStatus, type Json, type Outcome } from '../../src/protocol';
import { blob, get } from './api';
import { TaskGrid, Timeline, type Lane, type Segment, type TaskState } from './charts';
import { ago, bytes, count, duration, h, icon, pill, replace, save, when, type Tone } from './dom';
import { counts, jobPill, nameOf, progress, STATE_WORDS, stateOf, tookOf } from './status';
import { describe, empty, poll, type View } from './view';

interface Landed {
  readonly outcome: Outcome;
  readonly at?: number;
}

const VESSEL_TONES: Readonly<Record<JobStatus['vessels'][number]['state'], Tone>> = { waiting: 'idle', booting: 'live', working: 'live', done: 'idle', failed: 'bad' };

const KEY: readonly TaskState[] = ['queued', 'running', 'green', 'red', 'timeout', 'lost', 'cancelled'];

export function jobView(id: string, opened: number | null): View {
  // The task the page was opened at, shown in its drawer once the job is first read.
  let opening = opened;
  const banner = h('div');
  const title = h('h1', {}, id);
  const pillSlot = h('div');
  const meta = h('div', { class: 'job-meta' });
  const summary = h('div', { class: 'summary' }, h('div', { class: 'skeleton' }));
  const vesselsBody = h('div', { class: 'vessels scroll-y' });
  const vesselsAside = h('span', { class: 'aside' });
  const tasksAside = h('span', { class: 'aside' });
  // The grid and the timeline are canvases: this opens a task by its number from the keyboard.
  const pick = h('input', { class: 'input task-pick', type: 'number', placeholder: 'Task', label: 'Task number' });

  const picker = h('form', {
    class: 'button-row',
    onsubmit: (event) => {
      event.preventDefault();
      const index = Number(pick.value);

      if (Number.isInteger(index) && index >= 0 && index < (status?.tasks.total ?? 0)) open(index);
    },
  }, pick, h('button', { class: 'button', type: 'submit' }, 'Open'));

  const problemsCard = h('div');
  const outcomes = new Map<number, Landed>();
  let status: JobStatus | null = null;
  let seq = 0;
  /** The job's items as last read: read again for a task past them, which an open job grows by. */
  let items: readonly Json[] = [];
  /** The task in the drawer, redrawn at each refresh. */
  let shown: number | null = null;
  const left = new AbortController();
  const { signal } = left;

  const drawer = new TaskDrawer(() => {
    shown = null;
    history.replaceState(null, '', `#/jobs/${id}`);
  });

  /** The containers that ran tasks in more than one slot, as of the last render. */
  let split: Split = new Map();
  const where = (vessel: string, slot: number | undefined): string => laneOf(vessel, slot, split);

  const grid = new TaskGrid('every task of the job, as a cell coloured by how it stands', (index) => describeTask(index), (index) => { open(index); });

  const timeline = new Timeline('each container of the job, with the tasks it ran over time', (segment) => describeSegment(segment), (segment) => {
    if (segment.task !== null) open(segment.task);
  });

  const describeTask = (index: number): HTMLElement => {
    const landed = outcomes.get(index);
    const running = status?.running?.find((each) => each.index === index);

    return h('div', {}, h('b', {}, `Task ${count(index)}`), h('span', { class: 'muted' }, detailOf(landed, running, where)));
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
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Tasks'), h('div', { class: 'button-row' }, tasksAside, picker)),
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
        h('span', {
          class: 'muted num',
          title: vessel.boot === undefined ? undefined : `waited ${duration(vessel.boot.waitMs)} for capacity, started in ${duration(vessel.boot.startMs)}${vessel.boot.restarts.length === 0 ? '' : ` (${vessel.boot.restarts.join('; ')})`}, set up in ${duration(vessel.boot.setupMs)}`,
        }, `${count(vessel.tasks)} task${vessel.tasks === 1 ? '' : 's'}${vessel.busyMs > 0 ? ` · busy ${duration(vessel.busyMs)}` : ''}${vessel.bootMs === null ? '' : ` · up in ${duration(vessel.bootMs)}`}`),
        h('span', { class: 'faint' }, vessel.state),
        vessel.error === null ? null : h('span', { class: 'error' }, vessel.error))));
    replace(problemsCard, status.problems.length === 0 ? null : h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Problems')),
      h('div', { class: 'card-body' }, h('ul', { class: 'problems' }, status.problems.map((problem) => h('li', {}, problem))))));
    const running = new Set((status.running ?? []).map((each) => each.index));

    grid.update(Array.from({ length: status.tasks.total }, (_, index) => stateNow(outcomes.get(index), running.has(index))));
    split = splitOf(status, outcomes);
    const { lanes, placed } = segments(status, outcomes, now, split);

    timeline.update(lanes, placed, { from: status.startedAt ?? status.createdAt, to: status.finishedAt ?? now, live: status.phase !== 'done' });

    if (shown !== null) drawTask(shown);
  };

  const drawTask = (index: number): void => {
    drawer.draw({ job: id, index, landed: outcomes.get(index) ?? null, running: status?.running?.find((each) => each.index === index) ?? null, item: items[index] ?? null, known: index < items.length, where });
  };

  const open = (index: number): void => {
    shown = index;
    history.replaceState(null, '', `#/jobs/${id}/${String(index)}`);
    drawTask(index);

    if (index < items.length) return;
    detach((async () => {
      items = (await get(`/jobs/${id}/items`, v.object({ items: v.array(JsonSchema) }), signal)).items;

      if (shown === index) drawTask(index);
    })(), (error) => {
      if (!signal.aborted) drawer.failed(describe(error));
    });
  };

  const pollster = poll(1500, banner, async (polled) => {
    status = await get(`/jobs/${id}`, JobStatusSchema, polled);

    for (let more = true; more;) {
      const batch = await get(`/jobs/${id}/events?after=${String(seq)}`, EventsSchema, polled);

      for (const event of batch.events) outcomes.set(event.outcome.index, { outcome: event.outcome, at: event.at });
      seq = batch.events.at(-1)?.seq ?? seq;
      more = batch.events.length > 0 && !batch.done;
    }

    render();

    if (opening !== null) {
      open(opening);
      opening = null;
    }

    // A job that ended is read once more and then held still.
    return status.phase !== 'done';
  });

  return {
    element,
    dispose: () => {
      left.abort();
      pollster.stop();
      grid.dispose();
      timeline.dispose();
      drawer.dispose();
    },
  };
}

/** The containers that ran tasks in more than one slot, each with those slots in order: each gets a lane a slot. */
type Split = ReadonlyMap<string, readonly number[]>;

/** Where a task ran: its container, and its slot where the container ran tasks in more than one. */
const laneOf = (vessel: string, slot: number | undefined, split: Split): string => split.has(vessel) ? `${vessel} · ${String(slot ?? 0)}` : vessel;

function splitOf(status: JobStatus, outcomes: ReadonlyMap<number, Landed>): Split {
  const slots = new Map<string, Set<number>>();

  for (const { vessel, slot } of [...[...outcomes.values()].map(({ outcome }) => outcome), ...status.running ?? []]) slots.set(vessel, (slots.get(vessel) ?? new Set()).add(slot ?? 0));

  return new Map([...slots].flatMap(([vessel, seen]) => seen.size > 1 ? [[vessel, [...seen].sort((left, right) => left - right)] as const] : []));
}

/** Every container's lanes, its start and every task it ran or runs, placed in time. A task answered before this
 *  Worker stamped outcomes has no place, nor does one answered from the cache. */
/** A job's timeline: its lanes, and each container's start and tasks placed on them. */
interface Placed {
  readonly lanes: Lane[];
  readonly placed: Segment[];
}

function segments(status: JobStatus, outcomes: ReadonlyMap<number, Landed>, now: number, split: Split): Placed {
  const tasks: Segment[] = [];
  /** Each container's first task's start, where its start ends. */
  const firsts = new Map<string, number>();

  const place = (vessel: string, slot: number | undefined, segment: Omit<Segment, 'lane'>): void => {
    firsts.set(vessel, Math.min(segment.start, firsts.get(vessel) ?? Infinity));
    tasks.push({ ...segment, lane: laneOf(vessel, slot, split) });
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
    const own = split.get(vessel.name)?.map((slot) => laneOf(vessel.name, slot, split)) ?? [vessel.name];
    const first = firsts.get(vessel.name);
    const boot = vessel.bootMs;

    lanes.push(...own.map((name): Lane => ({ name, state: vessel.state })));

    // A container's start ends where its first task begins, on each of its lanes.
    if (boot !== null && first !== undefined) starts.push(...own.map((lane): Segment => ({ lane, task: null, start: Math.max(from, first - boot), end: first, state: 'boot' })));
  }

  return { lanes, placed: [...starts, ...tasks] };
}

/** What a task's drawer shows: the job and task, how it landed or where it runs, and its item, `known` once read. */
interface Drawn {
  readonly job: string;
  readonly index: number;
  readonly landed: Landed | null;
  readonly running: Running | null;
  readonly item: Json;
  readonly known: boolean;
  readonly where: (vessel: string, slot: number | undefined) => string;
}

const TONES: Readonly<Record<TaskState, Tone>> = { queued: 'idle', running: 'live', green: 'ok', red: 'bad', timeout: 'warn', lost: 'bad', cancelled: 'idle' };

/** A task in a modal drawer, redrawn as its job is: `closed` is told when the user closes it, never when its page is
 *  left. The browser keeps focus in it and closes the topmost dialog on Escape. A poll that changes nothing it shows
 *  but a running task's time leaves its nodes, so the focus and scroll in it stay where the user left them. */
class TaskDrawer {
  private readonly dialog = h('dialog', { class: 'drawer' });
  private readonly body = h('div', { class: 'drawer-body' });
  private readonly head = h('div', { class: 'button-row' });
  private readonly heading = h('h2');
  private readonly problem = h('p', { class: 'error' });
  private readonly item = h('pre', { class: 'code' });
  private readonly since = h('dd');
  private readonly log = new LogDialog();
  private task = '';
  private drawn = '';
  private disposing = false;

  constructor(closed: () => void) {
    const closer = h('button', { class: 'icon-button', type: 'button', label: 'Close', onclick: () => { this.dialog.close(); } }, icon('close'));

    this.dialog.append(h('div', { class: 'drawer-head' }, this.heading, h('div', { class: 'button-row' }, this.head, closer)), this.body);
    this.dialog.addEventListener('close', () => {
      this.task = '';

      if (!this.disposing) closed();
    });
    // A click on the backdrop, outside the drawer's box, closes it.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    document.body.append(this.dialog);
  }

  draw({ job, index, landed, running, item, known, where }: Drawn): void {
    const outcome = landed?.outcome;
    const state = stateNow(landed ?? undefined, running !== null);

    if (running !== null) replace(this.since, duration(Date.now() - running.started));
    const task = `${job}/${String(index)}`;
    const drawn = JSON.stringify([state, landed?.at, outcome?.attempt, running?.vessel, running?.slot, running?.started, known]);

    if (task === this.task && drawn === this.drawn) return;

    // Another task's problem is not this one's.
    if (task !== this.task) replace(this.problem);
    this.task = task;
    this.drawn = drawn;
    const fact = (term: string, value: string | null) => value === null ? null : h('div', {}, h('dt', {}, term), h('dd', {}, value));
    const fetched = (path: string, name: string) => () => { detach(download(path, name), (error) => { replace(this.problem, describe(error)); }); };

    replace(this.item, known ? JSON.stringify(item, null, 2) : '…');
    this.dialog.setAttribute('aria-label', `Task ${String(index)}`);
    replace(this.heading, `Task ${count(index)}`);
    replace(this.head, pill(TONES[state], STATE_WORDS[state]));
    replace(this.body,
      outcome === undefined
        ? h('dl', { class: 'facts' }, fact('Container', running === null ? null : where(running.vessel, running.slot)), running === null ? null : h('div', {}, h('dt', {}, 'Running for'), this.since),
          running === null ? fact('State', 'queued: no container has taken it yet') : null)
        : h('dl', { class: 'facts' },
          fact('Exit code', outcome.kind === 'exited' ? String(outcome.exitCode) : null),
          fact('Took', duration(outcome.seconds * 1000)),
          fact('Container', outcome.vessel === '' ? null : where(outcome.vessel, outcome.slot)),
          fact('Attempt', String(outcome.attempt)),
          fact('Landed', landed?.at === undefined ? null : when(landed.at)),
          fact('Peak memory', outcome.peakMemory === undefined ? null : bytes(outcome.peakMemory)),
          fact('CPU', outcome.cpuSeconds === undefined || outcome.seconds === 0 ? null : `${(outcome.cpuSeconds / outcome.seconds).toFixed(2)} cores on average`),
          fact('Error', outcome.error ?? null),
          fact('Answered', outcome.cached === true ? 'from the cache; nothing ran' : null)),
      h('div', {}, h('p', { class: 'section-label' }, 'Item'), this.item),
      outcome?.value === undefined ? null : h('div', {}, h('p', { class: 'section-label' }, 'Output'), h('pre', { class: 'code' }, outcome.value)),
      outcome === undefined || outcome.tail === '' ? null : h('div', {}, h('p', { class: 'section-label' }, 'End of its log'), h('pre', { class: 'code' }, outcome.tail)),
      outcome === undefined ? null : h('div', { class: 'button-row' },
        h('button', { class: 'button', type: 'button', onclick: () => { this.log.show(job, index); } }, icon('log'), 'Whole log'),
        outcome.output ? h('button', { class: 'button', type: 'button', onclick: fetched(`/jobs/${job}/tasks/${String(index)}/output`, `${job}-${String(index)}.out`) }, icon('download'), 'Output') : null,
        outcome.artifacts === true ? h('button', { class: 'button', type: 'button', onclick: fetched(`/jobs/${job}/tasks/${String(index)}/artifacts`, `${job}-${String(index)}-artifacts.tar.gz`) }, icon('download'), 'Artifacts') : null),
      this.problem);

    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Why the item could not be read, in its place. */
  failed(said: string): void {
    replace(this.item, said);
  }

  /** Its page is left: it goes, its history untouched. */
  dispose(): void {
    this.disposing = true;
    this.log.dispose();
    this.dialog.close();
    this.dialog.remove();
  }
}

async function download(path: string, name: string): Promise<void> {
  const found = await blob(path);

  if (found !== null) save(found, name);
}

/** A task's whole log, in a modal window over the drawer. */
class LogDialog {
  private readonly dialog = h('dialog', { class: 'modal' });
  private readonly heading = h('h2');
  private readonly body = h('pre', { class: 'code tall' });
  private text = '';
  private name = '';
  private reading: AbortController | null = null;

  constructor() {
    this.dialog.append(
      h('div', { class: 'drawer-head' }, this.heading, h('div', { class: 'button-row' },
        h('button', { class: 'button', type: 'button', onclick: () => { save(new Blob([this.text], { type: 'text/plain' }), this.name); } }, icon('download'), 'Save'),
        h('button', { class: 'icon-button', type: 'button', label: 'Close', onclick: () => { this.dialog.close(); } }, icon('close')))),
      h('div', { class: 'drawer-body' }, this.body));
    // The close event comes after close() returns: a log opened again by then keeps its read.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.reading?.abort();
    });
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    document.body.append(this.dialog);
  }

  show(job: string, index: number): void {
    this.reading?.abort();
    const reading = new AbortController();

    this.reading = reading;
    this.text = '';
    this.name = `${job}-${String(index)}.log`;
    this.dialog.setAttribute('aria-label', `Task ${String(index)}'s log`);
    replace(this.heading, `Task ${count(index)}'s log`);
    replace(this.body, 'Reading the log…');
    this.dialog.showModal();
    detach((async () => {
      const found = await blob(`/jobs/${job}/tasks/${String(index)}/log`, reading.signal);
      const text = found === null ? '' : await found.text();

      // A log closed, or another opened, while its text was read: this one shows nothing now.
      if (reading.signal.aborted) return;
      this.text = text;
      replace(this.body, logText(found === null ? null : text));
      // A log ends with how its task ended, so it opens at its end.
      this.body.scrollTop = this.body.scrollHeight;
    })(), (error) => {
      if (!reading.signal.aborted) replace(this.body, describe(error));
    });
  }

  dispose(): void {
    this.reading?.abort();
    this.dialog.close();
    this.dialog.remove();
  }
}

/** Where a task runs now. */
type Running = NonNullable<JobStatus['running']>[number];

/** A task's state: how it landed, else running or queued. */
function stateNow(landed: Landed | undefined, running: boolean): TaskState {
  if (landed !== undefined) return stateOf(landed.outcome);

  return running ? 'running' : 'queued';
}

/** A task cell's hover line: how it landed and where, how long it has run and where, or that it waits. */
function detailOf(landed: Landed | undefined, running: Running | undefined, where: (vessel: string, slot: number | undefined) => string): string {
  if (landed !== undefined) {
    const { outcome } = landed;

    return `${STATE_WORDS[stateOf(outcome)]}${outcome.cached === true ? ', from the cache' : ''} · ${duration(outcome.seconds * 1000)}${outcome.vessel === '' ? '' : ` on ${where(outcome.vessel, outcome.slot)}`}`;
  }

  return running === undefined ? 'queued' : `running on ${where(running.vessel, running.slot)} for ${duration(Date.now() - running.started)}`;
}

/** What a log's window shows: the log, or why there is none to show. */
function logText(text: string | null): string {
  if (text === null) return 'This task kept no log: it never ran, or its log has expired (a job\'s files last 7 days).';

  return text === '' ? 'The task printed nothing.' : text;
}
