/**
 * The overview: what the deployment's fleet holds now, drawn as the banner's cells (each job's share in a shade of
 * orange, what is free a dim dot), and the jobs made last, newest first.
 */
import * as v from 'valibot';
import { FleetSchema, HealthSchema, JobsSchema, type Fleet, type JobBrief } from '../../src/protocol';
import { get } from './api';
import { ago, count, duration, h, replace } from './dom';
import { jobPill, nameOf, progress, tookOf } from './status';
import { empty, poll, type View } from './view';

/** The fleet's picture: this many cells, each a share of its cap. */
const CELLS = 120;

/** Jobs a page of the list holds. */
const PAGE = 30;

const SHADES = ['', 'share-1', 'share-2', 'share-3'] as const;

const shade = (rank: number): string => SHADES[Math.min(rank, SHADES.length - 1)] ?? '';

export function overview(): View {
  const banner = h('div');
  const figure = h('div', { class: 'stats' });
  const fleetBody = h('div', { class: 'card-body' });
  const jobsBody = h('div', { class: 'card-body flush' });
  const secretsBody = h('div', { class: 'card-body' });
  const lead = h('p', {}, 'Reading the fleet…');
  /** Older pages, read when asked for; the first page is read again at each poll. */
  let older: JobBrief[] = [];
  let first: JobBrief[] = [];
  let exhausted = false;

  const element = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Fleet'), lead)),
    banner,
    h('div', { class: 'grid grid-overview' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Containers now')), fleetBody),
      h('div', { class: 'stack' }, figure, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Secrets')), secretsBody))),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Recent jobs'), h('span', { class: 'aside' }, 'newest first')), jobsBody));
  const drawJobs = (): void => {
    const all = [...first, ...older.filter((job) => !first.some((each) => each.id === job.id))];

    if (all.length === 0) {
      replace(jobsBody, empty('No jobs yet', 'Start one with ', h('span', { class: 'mono' }, 'armada map --times=3 -- echo hello {item}')));

      return;
    }
    const more = exhausted ? null : h('div', { class: 'more' }, h('button', {
      class: 'button', type: 'button',
      onclick: (event) => {
        const button = event.currentTarget;

        if (button instanceof HTMLButtonElement) button.disabled = true;
        void get(`/jobs?limit=${String(PAGE)}&before=${encodeURIComponent(all.at(-1)?.id ?? '')}`, JobsSchema).then(({ jobs }) => {
          older = [...older, ...jobs];
          exhausted = jobs.length < PAGE;
          drawJobs();
        });
      },
    }, 'Show older'));

    replace(jobsBody, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Job'), h('th', {}, 'Status'), h('th', {}, 'Tasks'), h('th', { class: 'right wide' }, 'Containers'), h('th', { class: 'wide' }, 'Started'),
        h('th', { class: 'right' }, 'Took'))),
      h('tbody', {}, all.map(row))), more);
  };

  const pollster = poll(4000, banner, async () => {
    const [health, fleet, jobs, secrets] = await Promise.all([
      get('/health', HealthSchema), get('/fleet', FleetSchema), get(`/jobs?limit=${String(PAGE)}`, JobsSchema), get('/secrets', v.object({ names: v.array(v.string()) })),
    ]);
    const used = fleet.jobs.reduce((sum, job) => sum + job.vcpus, 0);
    const containers = fleet.jobs.reduce((sum, job) => sum + job.containers, 0);
    const open = jobs.jobs.filter((job) => job.phase !== 'done');

    first = jobs.jobs;

    if (older.length === 0) exhausted = jobs.jobs.length < PAGE;
    replace(lead, health.jobs === 0 ? 'Nothing runs now.' : `${count(health.jobs)} job${health.jobs === 1 ? '' : 's'} open on ${count(containers)} container${containers === 1 ? '' : 's'}.`);
    replace(figure,
      stat('vCPUs in use', count(used), `of ${count(fleet.cap)}`),
      stat('Containers', count(containers)),
      stat('Tasks running', count(open.reduce((sum, job) => sum + job.tasks.running, 0))),
      stat('Tasks queued', count(open.reduce((sum, job) => sum + job.tasks.queued, 0))));
    replace(fleetBody, ...fleetPicture(fleet, used, new Map([...first, ...older].map((job) => [job.id, nameOf(job)]))));
    replace(secretsBody, secrets.names.length === 0
      ? h('p', { class: 'muted' }, 'None set. ', h('span', { class: 'mono' }, 'armada secret set NAME'), ' sets one; no page reads a value back.')
      : h('div', { class: 'button-row' }, secrets.names.map((name) => h('span', { class: 'pill mono' }, name))));
    drawJobs();
    document.title = health.jobs === 0 ? 'armada' : `armada · ${count(health.jobs)} open`;

    return true;
  });

  return { element, dispose: pollster.stop };
}

function stat(label: string, value: string, unit?: string): HTMLDivElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value, unit === undefined ? null : h('small', {}, unit)));
}

/** The fleet as cells: each job's share in its shade, largest first, then what is free. */
function fleetPicture(fleet: Fleet, used: number, names: ReadonlyMap<string, string>): HTMLElement[] {
  const per = fleet.cap / CELLS;
  const cells: HTMLElement[] = [];

  fleet.jobs.forEach((job, rank) => {
    // A job holding anything shows at least one cell.
    const many = Math.max(1, Math.round(job.vcpus / per));

    for (let at = 0; at < many && cells.length < CELLS; at += 1) cells.push(h('i', { class: shade(rank), title: `${names.get(job.id) ?? job.id}: ${count(job.vcpus)} vCPU` }));
  });

  while (cells.length < CELLS) cells.push(h('i', { class: 'free' }));

  return [
    h('div', { class: 'fleet-figure' }, h('strong', {}, count(used)), h('span', {}, `of ${count(fleet.cap)} vCPUs`)),
    h('div', { class: 'cells', label: `${count(used)} of ${count(fleet.cap)} vCPUs in use` }, cells),
    fleet.jobs.length === 0 ? h('p', { class: 'muted' }, 'No container is up.') : h('div', { class: 'legend' }, fleet.jobs.map((job, rank) => h('a', { class: 'legend-row', href: `#/jobs/${job.id}` },
      h('span', { class: `legend-swatch ${shade(rank)}` }), h('span', { class: 'legend-name' }, names.get(job.id) ?? job.id),
      h('span', { class: 'muted num' }, `${count(job.containers)} container${job.containers === 1 ? '' : 's'}`), h('span', { class: 'num' }, `${count(job.vcpus)} vCPU`)))),
  ];
}

function row(job: JobBrief): HTMLTableRowElement {
  const done = job.tasks.exited + job.tasks.failed;

  return h('tr', { data: { href: `#/jobs/${job.id}` }, onclick: () => { location.hash = `#/jobs/${job.id}`; } },
    h('td', {}, h('a', { class: 'job-name', href: `#/jobs/${job.id}` }, h('strong', {}, nameOf(job)), job.label === '' ? null : h('span', {}, job.id))),
    h('td', {}, jobPill(job)),
    h('td', {}, h('div', { class: 'progress-cell' }, progress(job.tasks), h('span', { class: 'num muted' }, `${count(done)}/${count(job.tasks.total)}`))),
    h('td', { class: 'right num wide' }, job.phase === 'done' ? count(job.containers) : `${count(job.alive)} up`),
    h('td', { class: 'muted wide', title: new Date(job.createdAt).toLocaleString() }, ago(job.createdAt)),
    h('td', { class: 'right num' }, duration(tookOf(job))));
}
