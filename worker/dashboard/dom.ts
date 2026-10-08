/**
 * The DOM, built by hand. Every string is a text node, never markup: a task's log and a job's label are whatever a user
 * or a program wrote. The page's policy refuses inline styles, so a style is set through the CSSOM.
 */

export type Child = Node | string | number | null | undefined | false | readonly Child[];

export interface Props {
  readonly class?: string;
  readonly title?: string;
  readonly href?: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly label?: string;
  readonly current?: boolean;
  readonly data?: Readonly<Record<string, string>>;
  readonly style?: Readonly<Partial<Pick<CSSStyleDeclaration, 'width' | 'height' | 'minWidth' | 'background'>>>;
  /** CSS custom properties, without their `--`. */
  readonly vars?: Readonly<Record<string, string>>;
  readonly onclick?: (event: MouseEvent) => void;
  readonly onsubmit?: (event: SubmitEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  // The element as any element, whose event map the listeners below are typed by.
  const element: HTMLElement = made;

  if (props.class !== undefined) element.className = props.class;

  if (props.title !== undefined) element.title = props.title;

  if (props.label !== undefined) element.setAttribute('aria-label', props.label);

  if (props.current === true) element.setAttribute('aria-current', 'page');

  for (const [name, value] of Object.entries(props.data ?? {})) element.dataset[name] = value;

  if (props.style !== undefined) Object.assign(element.style, props.style);

  for (const [name, value] of Object.entries(props.vars ?? {})) element.style.setProperty(`--${name}`, value);

  if (props.onclick !== undefined) element.addEventListener('click', props.onclick);

  if (element instanceof HTMLAnchorElement && props.href !== undefined) element.href = props.href;

  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
    if (props.type !== undefined) element.setAttribute('type', props.type);

    if (props.value !== undefined) element.value = props.value;
  }

  if (element instanceof HTMLInputElement && props.placeholder !== undefined) element.placeholder = props.placeholder;

  if (element instanceof HTMLFormElement && props.onsubmit !== undefined) {
    const onsubmit = props.onsubmit;

    element.addEventListener('submit', (event) => { onsubmit(event); });
  }

  append(element, children);

  return made;
}

const isList = (child: Child): child is readonly Child[] => Array.isArray(child);

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;

    if (child instanceof Node) parent.appendChild(child);
    else if (isList(child)) append(parent, child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** `parent`'s children replaced by `children`. */
export function replace(parent: Node, ...children: Child[]): void {
  while (parent.firstChild !== null) parent.removeChild(parent.firstChild);
  append(parent, children);
}

const SVG = 'http://www.w3.org/2000/svg';

/** The icons, as 24-unit stroke paths. */
const ICONS = {
  back: ['M15 18l-6-6 6-6'],
  sun: ['M12 4V2', 'M12 22v-2', 'M4.93 4.93L3.5 3.5', 'M20.5 20.5l-1.43-1.43', 'M4 12H2', 'M22 12h-2', 'M4.93 19.07L3.5 20.5', 'M20.5 3.5l-1.43 1.43', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  out: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l5-5-5-5', 'M15 12H4'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  log: ['M5 4h14v16H5z', 'M9 9h6', 'M9 13h6', 'M9 17h3'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
} as const;

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, 'path');

    path.setAttribute('d', d);
    svg.appendChild(path);
  }

  return svg;
}

const numbers = new Intl.NumberFormat('en-US');

export const count = (value: number): string => numbers.format(value);

/** A duration for a person: `850 ms`, `4.2 s`, `3 min 12 s`, `2 h 5 min`. Each unit is chosen after rounding to it,
 *  so 59.6 s reads `1 min 0 s`, never `60 s`. */
export function duration(ms: number): string {
  const millis = Math.max(0, Math.round(ms));

  if (millis < 1000) return `${String(millis)} ms`;
  const tenths = Math.round(ms / 100);

  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);

  if (seconds < 60) return `${String(seconds)} s`;

  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
  const minutes = Math.round(ms / 60_000);

  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

/** How long ago `at` was: `12 s ago`, `3 min ago`, `5 h ago`, then the date. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));

  if (seconds < 60) return `${String(seconds)} s ago`;

  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;

  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h ago`;

  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export const when = (at: number): string => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

export function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value / 1024;
  let unit = 0;

  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${units[unit] ?? 'TiB'}`;
}

/** A pill: a word with a dot whose tone says how it stands. */
export type Tone = 'live' | 'ok' | 'bad' | 'warn' | 'idle';

export function pill(tone: Tone, text: string): HTMLSpanElement {
  return h('span', { class: `pill ${tone === 'idle' ? '' : tone}` }, h('span', { class: `dot ${tone}` }), text);
}

/** Saves `blob` as `name` through the browser. */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url });

  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
}
