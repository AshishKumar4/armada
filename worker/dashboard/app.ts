/**
 * armada's dashboard: the deployment's fleet and recent jobs, a job followed live, its environments, and its CI
 * verdicts. The Worker serves it as static files under /ui/; `armada dashboard` opens it signed in.
 */
import { detach, errorOf, type Health } from '../../src/protocol';
import { deployment, signIn, signOut, SignedOut, takeToken, token } from './api';
import { ci } from './ci';
import { environments } from './environments';
import { h, icon, replace } from './dom';
import { jobView } from './job';
import { overview } from './overview';
import { describe, whenSignedOut, type View } from './view';

type Route =
  | { readonly page: 'overview' }
  | { readonly page: 'job'; readonly id: string; readonly task: number | null }
  | { readonly page: 'environments' }
  | { readonly page: 'ci'; readonly project: string | null; readonly sha: string | null };

function routeOf(hash: string): Route {
  const [page = '', first, second] = hash.replace(/^#\/?/u, '').split('/');

  if (page === 'jobs' && first !== undefined && first !== '') return { page: 'job', id: first, task: second !== undefined && /^\d+$/u.test(second) ? Number(second) : null };

  if (page === 'environments') return { page: 'environments' };

  if (page === 'ci') return { page: 'ci', project: first === undefined || first === '' ? null : first, sha: second ?? null };

  return { page: 'overview' };
}

function viewOf(route: Route): View {
  switch (route.page) {
    case 'overview': return overview();
    case 'job': return jobView(route.id, route.task);
    case 'environments': return environments();
    case 'ci': return ci(route.project, route.sha);
  }
}

const THEME = 'armada.theme';

/** The theme now: one chosen here, else the system's. */
function theme(): 'light' | 'dark' {
  const chosen = localStorage.getItem(THEME);

  if (chosen === 'light' || chosen === 'dark') return chosen;

  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(): void {
  const chosen = localStorage.getItem(THEME);

  if (chosen === 'light' || chosen === 'dark') document.documentElement.dataset['theme'] = chosen;
  else delete document.documentElement.dataset['theme'];
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

/** The page's frame: its navigation, and the main element each view fills. */
interface Frame {
  readonly main: HTMLElement;
  readonly nav: HTMLElement;
}

function shell(health: Health, host: string): Frame {
  const nav = h('nav', { class: 'nav', label: 'Pages' },
    h('a', { href: '#/', data: { page: 'overview' } }, 'Fleet'), h('a', { href: '#/environments', data: { page: 'environments' } }, 'Environments'), h('a', { href: '#/ci', data: { page: 'ci' } }, 'CI'));

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
        h('span', { class: 'host', title: `${host}: runner layer ${String(health.driver)}, wire ${String(health.protocol)}` }, h('span', { class: 'dot ok' }), host.split('.')[0] ?? host),
        themeButton,
        // A dashboard served from this machine (`armada dashboard --serve`) signs its requests itself, and holds no token.
        token() === null ? null : h('button', { class: 'icon-button', type: 'button', label: 'Sign out', title: 'Sign out', onclick: () => { signOut(); signInPage(); } }, icon('out'))))),
    main);

  return { main, nav };
}

let current: View | null = null;

function show(main: HTMLElement, nav: HTMLElement): void {
  const route = routeOf(location.hash);

  current?.dispose();
  current = viewOf(route);
  replace(main, current.element);

  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset['page'] === (route.page === 'job' ? 'overview' : route.page)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  window.scrollTo(0, 0);
}

let routed: (() => void) | null = null;

async function start(): Promise<void> {
  current?.dispose();
  current = null;

  if (routed !== null) window.removeEventListener('hashchange', routed);

  try {
    const { health, host } = await deployment();
    const { main, nav } = shell(health, host);

    routed = () => { show(main, nav); };

    window.addEventListener('hashchange', routed);
    show(main, nav);
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
