/**
 * The overview: what a deployment's fleet holds now, drawn as the banner's cells (each job's share in a shade of
 * orange, what is free a dim dot), and the jobs made last, newest first. Read beside other deployments (`armada
 * dashboard --all`), it shows each one's fleet in a row and all their jobs in one list, which a search and a project,
 * and a deployment, narrow.
 */
import * as v from 'valibot';
import { briefOf, detach, errorOf, FleetSchema, HealthSchema, JobsSchema, JobStatusSchema, type Fleet, type Health, type JobBrief } from '../../src/protocol';
import { labelOf, SignedOut, type Client } from './api';
import { ago, count, duration, h, icon, replace } from './dom';
import { jobPill, nameOf, progress, tookOf } from './status';
import { describe, empty, failed, poll, type View } from './view';

/** The fleet's picture: this many cells, each a share of its cap. */
const CELLS = 120;

/** A deployment's row of cells beside others'. */
const ROW_CELLS = 60;

/** Jobs a page of the list holds. */
const PAGE = 30;

const SHADES = ['', 'share-1', 'share-2', 'share-3'] as const;

const shade = (rank: number): string => SHADES[Math.min(rank, SHADES.length - 1)] ?? '';

/** A job in the list, with the deployment it is on. */
interface Listed {
  readonly at: Client;
  readonly job: JobBrief;
}

/** Whether `read` has an older page to show: one that does not answer has none. */
const pages = (read: Read): boolean => !read.exhausted && !(read.now instanceof Error);

/** A deployment as last read: every job read so far by id (each poll's first page and each older page merged in, so a
 *  job that a newer one pushes off the first page stays where it was), whether an older page is left, and its fleet or
 *  why it did not answer. */
interface Read {
  readonly listed: Map<string, JobBrief>;
  exhausted: boolean;
  now: { readonly health: Health; readonly fleet: Fleet } | Error | null;
}

/** The fleet of `first`, beside `rest`'s; `beside` when the page reads other deployments, so one's own fleet page leads
 *  back to every one's. */
export function overview(first: Client, rest: readonly Client[] = [], beside = false): View {
  const deployments = [first, ...rest];
  const single = rest.length === 0;
  // One deployment's own page beside others is named for it.
  const named = beside ? first.name : 'Fleet';
  const banner = h('div');
  const figure = h('div', { class: 'stats' });
  const fleetBody = h('div', { class: 'card-body' });
  const jobsBody = h('div', { class: 'card-body flush' });
  const secretsBody = h('div', { class: 'card-body' });
  const lead = h('p', {}, 'Reading the fleet…');
  const reads = new Map<Client, Read>(deployments.map((at) => [at, { listed: new Map(), exhausted: false, now: null }]));
  let older = false;
  const filter = { text: '', project: '', deployment: '' };

  const search = h('input', { class: 'input filter-text', type: 'search', placeholder: 'Search jobs', label: 'Search jobs by label, id or project' });
  const projects = h('select', { class: 'input filter-pick', label: 'Project' });
  const places = h('select', { class: 'input filter-pick', label: 'Deployment' });
  const filters = h('div', { class: 'filters' }, search, projects, single ? null : places);

  const element = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {},
      beside ? h('a', { class: 'back', href: '#/' }, icon('back'), 'Every deployment') : null, h('h1', {}, single ? named : 'Fleets'), lead)),
    banner,
    single
      ? h('div', { class: 'grid grid-overview' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Containers now')), fleetBody),
        h('div', { class: 'stack' }, figure, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Secrets')), secretsBody)))
      : h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Deployments'), h('span', { class: 'aside' }, 'containers now')), fleetBody),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Recent jobs'), filters), jobsBody));

  /** A deployment's failure is its own, shown in its row, when the page reads others; this page's own refusing its
   *  bearer signs the page out. */
  const ownFailure = (read: Read, error: Error): void => {
    if (error instanceof SignedOut || single) throw error;
    read.now = error;
  };

  const all = (): Listed[] => [...reads].flatMap(([at, read]) => [...read.listed.values()].map((job) => ({ at, job })))
    .sort((left, right) => right.job.createdAt - left.job.createdAt || right.job.id.localeCompare(left.job.id));

  const shown = (listed: Listed): boolean => {
    const { job, at } = listed;
    const text = filter.text.trim().toLowerCase();

    return (filter.project === '' || job.project === filter.project) && (filter.deployment === '' || at.host === filter.deployment)
      && (text === '' || [job.label, job.id, job.project ?? ''].some((each) => each.toLowerCase().includes(text)));
  };

  /** A select's options: every value, the chosen one kept even once no job has it, and none shown while there is
   *  nothing to choose. Drawn again only when they change, so a poll never closes a list being picked from. */
  const options = (select: HTMLSelectElement, everyone: string, choices: ReadonlyMap<string, string>, chosen: string): void => {
    const kept = [...new Map([...chosen === '' ? [] : [[chosen, chosen] as const], ...choices])].sort(([, left], [, right]) => left.localeCompare(right));
    const drawn = kept.map((choice) => choice.join('\t')).join('\n');

    select.hidden = kept.length === 0;

    if (select.dataset['drawn'] === drawn) return;
    const any = h('option', {}, everyone);

    any.value = '';

    replace(select, any, kept.map(([value, label]) => {
      const option = h('option', {}, label);

      option.value = value;

      return option;
    }));
    select.value = chosen;
    select.dataset['drawn'] = drawn;
  };

  const drawJobs = (): void => {
    const listed = all();

    options(projects, 'Every project', new Map(listed.flatMap(({ job }) => job.project === null ? [] : [[job.project, job.project] as const])), filter.project);
    options(places, 'Every deployment', new Map(deployments.map((at) => [at.host, labelOf(at, deployments)])), filter.deployment);

    if (listed.length === 0) {
      replace(jobsBody, empty('No jobs yet', 'Start one with ', h('span', { class: 'mono' }, 'armada map --times=3 -- echo hello {item}')));

      return;
    }

    const rows = listed.filter(shown);
    const exhausted = ![...reads.values()].some(pages);

    const more = exhausted ? null : h('div', { class: 'more' }, h('button', {
      class: 'button', type: 'button',
      onclick: (event) => {
        const button = event.currentTarget;

        if (button instanceof HTMLButtonElement) button.disabled = true;
        // Each deployment pages back by itself: one that fails says so in its row, and the others' pages show.
        detach(Promise.all([...reads].filter(([, read]) => pages(read)).map(async ([at, read]) => {
          try {
            const oldest = [...read.listed.keys()].sort().at(0) ?? '';
            const { jobs } = await at.get(`/jobs?limit=${String(PAGE)}&before=${encodeURIComponent(oldest)}`, JobsSchema);

            read.exhausted = jobs.length < PAGE;

            for (const job of jobs) read.listed.set(job.id, job);
          } catch (cause) {
            ownFailure(read, errorOf({ cause }));
          }
        })).then(() => {
          older = true;
          drawJobs();
        }), (error) => {
          if (button instanceof HTMLButtonElement) button.disabled = false;
          failed(banner, error);
        });
      },
    }, 'Show older'));

    replace(jobsBody, rows.length === 0 ? empty('No job matches', 'Clear the search, or show older jobs.') : h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Job'), single ? null : h('th', { class: 'wide' }, 'Deployment'), h('th', {}, 'Status'), h('th', {}, 'Tasks'),
        h('th', { class: 'right wide' }, 'Containers'), h('th', { class: 'wide' }, 'Started'), h('th', { class: 'right' }, 'Took'))),
      h('tbody', {}, rows.map((each) => row(each, single ? null : labelOf(each.at, deployments))))), more);
  };

  search.addEventListener('input', () => {
    filter.text = search.value;
    drawJobs();
  });

  projects.addEventListener('change', () => {
    filter.project = projects.value;
    drawJobs();
  });

  places.addEventListener('change', () => {
    filter.deployment = places.value;
    drawJobs();
  });

  /** One deployment read again: its health, fleet and first page, and each job kept from before that the first page no
   *  longer holds, read by itself until it is done. Its failure is its own; this page's own refusing the bearer signs
   *  the page out. */
  const refresh = async (at: Client, read: Read, signal: AbortSignal): Promise<void> => {
    try {
      const [health, fleet, jobs] = await Promise.all([
        at.get('/health', HealthSchema, signal), at.get('/fleet', FleetSchema, signal), at.get(`/jobs?limit=${String(PAGE)}`, JobsSchema, signal),
      ]);

      const fresh = new Set(jobs.jobs.map((job) => job.id));
      const kept = [...read.listed.values()].filter((job) => job.phase !== 'done' && !fresh.has(job.id));
      const again = await Promise.all(kept.map(async (job) => briefOf(await at.get(`/jobs/${job.id}`, JobStatusSchema, signal))));

      for (const job of [...jobs.jobs, ...again]) read.listed.set(job.id, job);

      if (!older) read.exhausted = jobs.jobs.length < PAGE;
      read.now = { health, fleet };
    } catch (cause) {
      if (signal.aborted) throw errorOf({ cause });
      ownFailure(read, errorOf({ cause }));
    }
  };

  const pollster = poll(4000, banner, async (signal) => {
    const secrets = single ? first.get('/secrets', v.object({ names: v.array(v.string()) }), signal) : undefined;

    await Promise.all([...reads].map(async ([at, read]) => { await refresh(at, read, signal); }));
    const answered = [...reads.values()].flatMap((read) => read.now === null || read.now instanceof Error ? [] : [read.now]);
    const open = answered.reduce((sum, now) => sum + now.health.jobs, 0);
    const containers = answered.reduce((sum, now) => sum + now.fleet.jobs.reduce((each, job) => each + job.containers, 0), 0);
    const names = new Map(all().map(({ job }) => [job.id, nameOf(job)]));

    replace(lead, open === 0 ? 'Nothing runs now.' : `${count(open)} job${open === 1 ? '' : 's'} open on ${count(containers)} container${containers === 1 ? '' : 's'}.`);

    if (single) {
      const [now] = answered;
      const set = (await secrets)?.names ?? [];

      if (now === undefined) return true;
      const used = now.fleet.jobs.reduce((sum, job) => sum + job.vcpus, 0);

      replace(figure,
        stat('vCPUs in use', count(used), `of ${count(now.fleet.cap)}`),
        stat('Containers', count(containers)),
        stat('Tasks running', count(now.fleet.tasks?.running ?? 0)),
        stat('Tasks queued', count(now.fleet.tasks?.queued ?? 0)));
      replace(fleetBody, ...fleetPicture(first, now.fleet, names));
      replace(secretsBody, set.length === 0
        ? h('p', { class: 'muted' }, 'None set. ', h('span', { class: 'mono' }, 'armada secret set NAME'), ' sets one; no page reads a value back.')
        : h('div', { class: 'button-row' }, set.map((name) => h('span', { class: 'pill mono' }, name))));
    } else {
      replace(fleetBody, h('div', { class: 'deployments' }, [...reads].map(([at, read]) => deploymentRow(at, labelOf(at, deployments), read, names))));
    }

    drawJobs();
    document.title = open === 0 ? 'armada' : `armada · ${count(open)} open`;

    return true;
  });

  return { element, dispose: () => { pollster.stop(); } };
}

function stat(label: string, value: string, unit?: string): HTMLDivElement {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value, unit === undefined ? null : h('small', {}, unit)));
}

/** A deployment beside others: its name, its fleet in a row of cells, and how many jobs and containers it has open, or
 *  why it did not answer. */
function deploymentRow(at: Client, label: string, read: Read, names: ReadonlyMap<string, string>): HTMLElement {
  const title = h('a', { class: 'deployment-name', href: at.href('') }, label);

  if (read.now === null) return h('div', { class: 'deployment' }, title, h('div', { class: 'skeleton' }));

  if (read.now instanceof Error) {
    // A Worker from before this page could read it from elsewhere answers nothing a browser lets it read.
    const why = read.now instanceof TypeError ? 'Unreadable from this page until armada deploy updates its Worker.' : describe(read.now);

    return h('div', { class: 'deployment' }, title, h('p', { class: 'error' }, why));
  }

  const { health, fleet } = read.now;
  const used = fleet.jobs.reduce((sum, job) => sum + job.vcpus, 0);
  const containers = fleet.jobs.reduce((sum, job) => sum + job.containers, 0);

  return h('div', { class: 'deployment' }, title,
    cellsOf(fleet, ROW_CELLS, names),
    h('span', { class: 'deployment-open muted num' }, `${count(health.jobs)} open · ${count(containers)} container${containers === 1 ? '' : 's'}`),
    h('span', { class: 'deployment-use num' }, `${count(used)} of ${count(fleet.cap)} vCPU`));
}

/** The fleet as `cells` cells: each job's share in its shade, largest first, then what is free. */
function cellsOf(fleet: Fleet, cells: number, names: ReadonlyMap<string, string>): HTMLElement {
  const used = fleet.jobs.reduce((sum, job) => sum + job.vcpus, 0);
  const per = fleet.cap / cells;
  const drawn: HTMLElement[] = [];

  for (const [rank, job] of fleet.jobs.entries()) {
    // A job holding anything shows at least one cell.
    const many = Math.max(1, Math.round(job.vcpus / per));

    for (let at = 0; at < many && drawn.length < cells; at += 1) drawn.push(h('i', { class: shade(rank), title: `${names.get(job.id) ?? job.id}: ${count(job.vcpus)} vCPU` }));
  }

  while (drawn.length < cells) drawn.push(h('i', { class: 'free' }));

  return h('div', { class: 'cells', label: `${count(used)} of ${count(fleet.cap)} vCPUs in use` }, drawn);
}

/** A deployment's fleet: how much it uses of its cap, its cells, and each job's share. */
function fleetPicture(at: Client, fleet: Fleet, names: ReadonlyMap<string, string>): HTMLElement[] {
  const used = fleet.jobs.reduce((sum, job) => sum + job.vcpus, 0);

  return [
    h('div', { class: 'fleet-figure' }, h('strong', {}, count(used)), h('span', {}, `of ${count(fleet.cap)} vCPUs`)),
    cellsOf(fleet, CELLS, names),
    fleet.jobs.length === 0 ? h('p', { class: 'muted' }, 'No container is up.') : h('div', { class: 'legend' }, fleet.jobs.map((job, rank) => h('a', { class: 'legend-row', href: at.href(`jobs/${job.id}`) },
      h('span', { class: `legend-swatch ${shade(rank)}` }), h('span', { class: 'legend-name' }, names.get(job.id) ?? job.id),
      h('span', { class: 'muted num' }, `${count(job.containers)} container${job.containers === 1 ? '' : 's'}`), h('span', { class: 'num' }, `${count(job.vcpus)} vCPU`)))),
  ];
}

function row({ at, job }: Listed, label: string | null): HTMLTableRowElement {
  const done = job.tasks.exited + job.tasks.failed;
  const href = at.href(`jobs/${job.id}`);

  return h('tr', { data: { href }, onclick: () => { location.hash = href; } },
    h('td', {}, h('a', { class: 'job-name', href }, h('strong', {}, nameOf(job)), h('span', {}, [job.project, job.label === '' ? null : job.id].filter((each) => each !== null).join(' · ')))),
    label === null ? null : h('td', { class: 'muted wide' }, label),
    h('td', {}, jobPill(job)),
    h('td', {}, h('div', { class: 'progress-cell' }, progress(job.tasks), h('span', { class: 'num muted' }, `${count(done)}/${count(job.tasks.total)}`))),
    h('td', { class: 'right num wide' }, job.phase === 'done' ? count(job.containers) : `${count(job.alive)} up`),
    h('td', { class: 'muted wide', title: new Date(job.createdAt).toLocaleString() }, ago(job.createdAt)),
    h('td', { class: 'right num' }, duration(tookOf(job))));
}
