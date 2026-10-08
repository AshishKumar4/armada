/** The deployment's environments: each recipe's snapshot, how long each phase of preparing it took, and when it was
 *  last started from. */
import * as v from 'valibot';
import { EnvironmentsSchema, type EnvironmentEntrySchema } from '../../src/protocol';
import { get } from './api';
import { ago, bytes, duration, h, pill, replace, when } from './dom';
import { empty, poll, type View } from './view';

type Entry = v.InferOutput<typeof EnvironmentEntrySchema>;

/** The phases of a preparation, in order (worker/src/environments.ts). */
const PHASES = ['base', 'setup', 'receive', 'install', 'snapshot'] as const;

export function environments(): View {
  const banner = h('div');
  const body = h('div', { class: 'card-body flush' }, h('div', { class: 'card-body' }, h('div', { class: 'skeleton' })));

  const element = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Environments'),
      h('p', {}, 'Each recipe is prepared once and snapshotted; every container of its jobs starts from the snapshot.'))),
    banner,
    h('section', { class: 'card' }, body));

  document.title = 'Environments · armada';

  const pollster = poll(10_000, banner, async () => {
    const listed = await get('/environments', EnvironmentsSchema);

    const order = (entry: Entry): number => {
      switch (entry.state) {
        case 'preparing': return Infinity;
        case 'ready': return entry.lastUsed;
        case 'failed': return entry.at;
      }
    };

    replace(body, listed.length === 0 ? empty('No environment yet', 'The first job of a recipe prepares one.') : h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Environment'), h('th', {}, 'State'), h('th', { class: 'wide' }, 'Commit'), h('th', { class: 'wide' }, 'Preparing took'),
        h('th', { class: 'right wide' }, 'Snapshot'), h('th', { class: 'right' }, 'Last used'))),
      h('tbody', {}, [...listed].sort((left, right) => order(right.entry) - order(left.entry)).map(({ key, entry }) => row(key, entry)))));

    return true;
  });

  return { element, dispose: () => { pollster.stop(); } };
}

function row(key: string, entry: Entry): HTMLTableRowElement {
  const name = h('td', { title: key }, h('span', { class: 'mono' }, key.slice(0, 12)));

  if (entry.state === 'preparing') {
    return h('tr', {}, name, h('td', {}, pill('live', 'preparing')), h('td', { class: 'mono wide' }, entry.sha?.slice(0, 10) ?? ''), h('td', { class: 'muted wide' }, `for ${duration(Date.now() - entry.since)}`),
      h('td', { class: 'wide' }), h('td', { class: 'right muted' }, ago(entry.since)));
  }

  if (entry.state === 'failed') {
    return h('tr', {}, name, h('td', {}, pill('bad', 'failed')), h('td', { class: 'muted', title: entry.reason }, entry.reason.slice(0, 140)), h('td', { class: 'wide' }), h('td', { class: 'wide' }),
      h('td', { class: 'right muted' }, ago(entry.at)));
  }

  const { generation } = entry;
  const total = PHASES.reduce((sum, phase) => sum + (generation.seconds[phase] ?? 0), 0);

  return h('tr', {}, name, h('td', {}, pill('ok', 'ready')),
    h('td', { class: 'mono wide' }, generation.sha?.slice(0, 10) ?? h('span', { class: 'faint' }, 'none')),
    h('td', { class: 'wide' }, h('div', { class: 'progress-cell' },
      h('div', { class: 'phases', title: PHASES.map((phase) => `${phase} ${duration((generation.seconds[phase] ?? 0) * 1000)}`).join(' · ') },
        PHASES.map((phase) => (generation.seconds[phase] ?? 0) === 0 ? null : h('span', { class: phase, style: { width: `${String(((generation.seconds[phase] ?? 0) / Math.max(total, 1)) * 100)}%` } }))),
      h('span', { class: 'num muted' }, duration(total * 1000)))),
    h('td', { class: 'right num wide' }, bytes(generation.snapshot.size)),
    h('td', { class: 'right muted', title: `prepared ${when(generation.created)}` }, ago(entry.lastUsed)));
}
