/** CI: each project's stored verdicts, newest first, and one verdict's rows, its red ones first with what they printed. */
import * as v from 'valibot';
import { rowName, VerdictFileSchema, type VerdictRow } from '../../src/grade';
import { ProjectsSchema, VerdictsSchema } from '../../src/protocol';
import { get } from './api';
import { ago, count, duration, h, icon, pill, replace, when } from './dom';
import { empty, poll, type View } from './view';

export function ci(project: string | null, sha: string | null): View {
  const banner = h('div');
  const tabs = h('nav', { class: 'tabs', label: 'Projects' });
  const body = h('section', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'skeleton' })));
  const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'CI'), h('p', {}, 'Every verdict armada run stored for a commit, the newest first.')));
  const element = h('div', { class: 'page' }, head, banner, tabs, body);

  document.title = 'CI · armada';
  const pollster = poll(15_000, banner, async () => {
    const { projects } = await get('/verdicts', ProjectsSchema);
    const shown = project ?? projects[0] ?? null;

    replace(tabs, projects.length < 2 ? null : projects.map((name) => h('a', { class: 'tab', href: `#/ci/${name}`, current: name === shown }, name)));

    if (shown === null) {
      replace(body, empty('No verdict yet', 'A whole ', h('span', { class: 'mono' }, 'armada run <commit>'), ' stores one.'));

      return false;
    }

    if (sha !== null) {
      replace(head, h('div', {}, h('a', { class: 'back', href: `#/ci/${shown}` }, icon('back'), shown), h('h1', { class: 'mono' }, sha.slice(0, 12))));
      replace(tabs);
      replace(body, verdict(await get(`/verdicts/${shown}/${sha}`, VerdictFileSchema)));

      return false;
    }
    const { verdicts } = await get(`/verdicts/${shown}`, VerdictsSchema);

    replace(body, verdicts.length === 0 ? empty('No verdict yet') : h('div', { class: 'rows' }, verdicts.map((each) => h('a', { class: 'row-link', href: `#/ci/${shown}/${each.sha}` },
      h('div', {}, h('div', { class: 'mono' }, each.sha.slice(0, 12)), h('div', { class: 'faint', title: when(each.uploaded) }, ago(each.uploaded))),
      h('span', { class: 'muted num' }, `${count(each.rows - each.reds)} of ${count(each.rows)} rows green`),
      each.reds === 0 ? pill('ok', 'pass') : pill('bad', `${count(each.reds)} red`)))));

    return true;
  });

  return { element, dispose: pollster.stop };
}

type File = v.InferOutput<typeof VerdictFileSchema>;

function verdict(file: File): HTMLElement {
  const reds = file.rows.filter((row) => row.exitCode !== 0);
  const ordered = [...reds, ...file.rows.filter((row) => row.exitCode === 0)];

  return h('div', {},
    h('div', { class: 'card-head' }, h('h2', {}, `${count(file.rows.length - reds.length)} of ${count(file.rows.length)} rows green`), reds.length === 0 ? pill('ok', 'pass') : pill('bad', 'fail')),
    h('div', { class: 'card-body flush' }, ordered.map(rowOf)));
}

function rowOf(row: VerdictRow): HTMLElement {
  const red = row.exitCode !== 0;
  const output = h('pre', { class: 'code' }, row.output);
  const details = h('details', { class: 'verdict-row' },
    h('summary', {}, h('span', { class: `dot ${red ? 'bad' : 'ok'}` }), h('span', { class: 'mono' }, rowName(row)),
      h('span', { class: 'faint' }, row.cached === undefined ? '' : `reused from ${row.cached.slice(0, 10)}`),
      h('span', { class: 'num muted' }, `${red ? `exit ${String(row.exitCode)} · ` : ''}${duration(row.seconds * 1000)}`)),
    row.output === '' ? h('p', { class: 'faint card-body' }, 'It printed nothing that was kept.') : output);

  // A row's output ends with why it failed, so it opens scrolled to its end. The toggle event comes once the row is on
  // the page, where the output has a height to scroll.
  details.addEventListener('toggle', () => {
    if (details.open) output.scrollTop = output.scrollHeight;
  });
  details.open = red;

  return details;
}
