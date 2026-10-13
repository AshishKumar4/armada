/**
 * armada's dashboard: the deployment's fleet and recent jobs, a job followed live, its environments, and its CI
 * verdicts. The Worker serves it as static files under /ui/; `armada dashboard` opens it signed in.
 */
import { detach, errorOf, type Health } from '../../src/protocol';
import { deployment, otherDeployments, signIn, signOut, SignedOut, takeToken, token, type Client } from './api';
import { ci } from './ci';
import { environments } from './environments';
import { h, icon, replace } from './dom';
import { jobView } from './job';
import { overview } from './overview';
import { describe, whenSignedOut, type View } from './view';

type Page =
  | { readonly page: 'overview' }
  | { readonly page: 'job'; readonly id: string; readonly task: number | null }
  | { readonly page: 'environments' }
  | { readonly page: 'ci'; readonly project: string | null; readonly sha: string | null };

/** A page, and the deployment it is of: one named `#/@<name>/…`, else this page's own, whose fleet page shows every
 *  deployment the browser reads. */
type Route = Page & { readonly at: string | null };

function routeOf(hash: string): Route {
  const path = hash.replace(/^#\/?/u, '').split('/');
  const at = path[0]?.startsWith('@') === true ? path.shift()?.slice(1) ?? null : null;
  const [page = '', first, second] = path;

  if (page === 'jobs' && first !== undefined && first !== '') return { at, page: 'job', id: first, task: second !== undefined && /^\d+$/u.test(second) ? Number(second) : null };

  if (page === 'environments') return { at, page: 'environments' };

  if (page === 'ci') return { at, page: 'ci', project: first === undefined || first === '' ? null : first, sha: second ?? null };

  return { at, page: 'overview' };
}

/** The deployments this page reads: its own first. */
interface Deployments {
  readonly own: Client;
  readonly others: readonly Client[];
}

/** The deployment `route` is of: one named and read here, else this page's own. */
const clientOf = (route: Route, { own, others }: Deployments): Client => [own, ...others].find((each) => each.name === route.at) ?? own;

function viewOf(route: Route, deployments: Deployments): View {
  const api = clientOf(route, deployments);

  switch (route.page) {
    case 'overview': return route.at === null ? overview(api, deployments.others) : overview(api);
    case 'job': return jobView(api, route.id, route.task);
    case 'environments': return environments(api);
    case 'ci': return ci(api, route.project, route.sha);
  }
}

const THEME = 'armada.theme';

/** The theme now: one chosen here, else the system's. */
function theme(): 'light' | 'dark' {
  const chosen = localStorage.getItem(THEME);

  if (chosen === 'light' || chosen === 'dark') return chosen;

  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The page in `theme()`: the one palette its CSS has for it. */
function applyTheme(): void {
  document.documentElement.dataset['theme'] = theme();
  // The canvases read the theme's colours when they paint.
  document.dispatchEvent(new Event('themechange'));
}

function brand(): HTMLElement {
  return h('a', { class: 'brand', href: '#/' }, 'armada', h('span', { class: 'brand-cells' }, h('span'), h('span'), h('span'), h('span')));
}

function signInPage(): void {
  const field = h('input', { class: 'input', type: 'password', placeholder: 'the token in ~/.config/armada/connection.json', label: 'Token' });

  document.title = 'Sign in · armada';
  replace(document.body, h('div', { class: 'signin' }, h('div', { class: 'card' },
    brand(),
    h('h1', {}, 'Open this dashboard from your terminal'),
    h('p', {}, 'It signs this browser in to this deployment, and the token never leaves it.'),
    h('pre', {}, 'armada dashboard'),
    h('form', {
      onsubmit: (event) => {
        event.preventDefault();

        if (field.value.trim() === '') return;
        signIn(field.value);
        restart();
      },
    }, field, h('button', { class: 'button primary', type: 'submit' }, 'Sign in with a token')))));
  field.focus();
}

/** The page's frame: its navigation, the deployment it shows when it reads others too, and the main element each view
 *  fills. */
interface Frame {
  readonly main: HTMLElement;
  readonly nav: HTMLElement;
  readonly picker: HTMLSelectElement | null;
}

/** Each page of the navigation, by the address of its first page on a deployment. */
const PAGES = [['overview', '', 'Fleet'], ['environments', 'environments', 'Environments'], ['ci', 'ci', 'CI']] as const;

function shell(health: Health, { own, others }: Deployments): Frame {
  const nav = h('nav', { class: 'nav', label: 'Pages' }, PAGES.map(([page, path, name]) => h('a', { data: { page, path } }, name)));

  // Beside others, the deployment shown is picked here: every one's fleet and jobs, or one's own pages.
  const picker = others.length === 0 ? null : h('select', { class: 'input deployment-pick', label: 'Deployment' },
    h('option', {}, 'Every deployment'), [own, ...others].map((each) => h('option', {}, each.name)));

  if (picker !== null) {
    picker.options[0]?.setAttribute('value', '');
    picker.addEventListener('change', () => { location.hash = picker.value === '' ? '#/' : `#/@${picker.value}/`; });
  }

  const themeButton = h('button', { class: 'icon-button', type: 'button', label: 'Switch between light and dark' });
  const drawTheme = (): void => { replace(themeButton, icon(theme() === 'dark' ? 'sun' : 'moon')); };

  const main = h('main');

  themeButton.addEventListener('click', () => {
    localStorage.setItem(THEME, theme() === 'dark' ? 'light' : 'dark');
    applyTheme();
    drawTheme();
  });
  drawTheme();
  replace(document.body,
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      brand(),
      nav,
      h('div', { class: 'topbar-end' },
        picker ?? h('span', { class: 'host', title: `${own.name}: runner layer ${String(health.driver)}, wire ${String(health.protocol)}` }, h('span', { class: 'dot ok' }), own.name),
        themeButton,
        // A dashboard served from this machine (`armada dashboard --serve`) signs its requests itself, and holds no token.
        token() === null ? null : h('button', { class: 'icon-button', type: 'button', label: 'Sign out', title: 'Sign out', onclick: () => { signOut(); signInPage(); } }, icon('out'))))),
    main);

  return { main, nav, picker };
}

let current: View | null = null;

function show({ main, nav, picker }: Frame, deployments: Deployments): void {
  const route = routeOf(location.hash);
  const api = clientOf(route, deployments);

  current?.dispose();
  current = viewOf(route, deployments);
  replace(main, current.element);

  for (const link of nav.querySelectorAll('a')) {
    link.href = api.href(link.dataset['path'] ?? '');

    if (link.dataset['page'] === (route.page === 'job' ? 'overview' : route.page)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  if (picker !== null) picker.value = route.at === null && route.page === 'overview' ? '' : api.name;

  window.scrollTo(0, 0);
}

let routed: (() => void) | null = null;

async function start(): Promise<void> {
  current?.dispose();
  current = null;

  if (routed !== null) window.removeEventListener('hashchange', routed);

  try {
    const { own, health } = await deployment();
    const deployments = { own, others: otherDeployments() };
    const frame = shell(health, deployments);

    routed = () => { show(frame, deployments); };

    window.addEventListener('hashchange', routed);
    show(frame, deployments);
  } catch (cause) {
    if (cause instanceof SignedOut) return signInPage();
    unanswered(errorOf({ cause }));
  }
}

/** The page when the Worker did not answer, with a way to ask again. */
function unanswered(error: Error): void {
  replace(document.body, h('div', { class: 'signin' }, h('div', { class: 'card' }, brand(), h('h1', {}, 'The Worker did not answer'), h('p', {}, describe(error)),
    h('button', { class: 'button', type: 'button', onclick: restart }, 'Try again'))));
}

function restart(): void {
  detach(start(), unanswered);
}

whenSignedOut(() => {
  current?.dispose();
  current = null;
  signOut();
  signInPage();
});

matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

takeToken();

applyTheme();

restart();
