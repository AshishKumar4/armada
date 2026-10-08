/** A page of the dashboard, and how it stays current: it polls while it is shown and stops when it is left. */
import { RequestError, SignedOut } from './api';
import { h, icon, replace } from './dom';

export interface View {
  readonly element: HTMLElement;
  dispose(): void;
}

/** Called once a request finds the bearer refused, to show the sign-in page. */
let onSignedOut: () => void = () => undefined;

export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}

/** Runs `refresh` now and then every `ms` after each run ends, while the page is visible, until `stop`. A failure is
 *  shown in `banner` and the next run tries again; a refused bearer signs out. `refresh` answers whether to go on. */
export function poll(ms: number, banner: HTMLElement, refresh: () => Promise<boolean>): { stop(): void; now(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const run = async (): Promise<void> => {
    clearTimeout(timer);

    if (stopped || running) return;
    running = true;
    let again = true;

    try {
      again = await refresh();
      replace(banner);
    } catch (cause) {
      if (cause instanceof SignedOut) {
        stopped = true;
        onSignedOut();

        return;
      }

      replace(banner, h('div', { class: 'error-banner' }, icon('alert'), describe(cause)));
    } finally {
      running = false;
    }

    if (!stopped && again && document.visibilityState === 'visible') timer = setTimeout(() => { void run(); }, ms);
  };

  const visible = (): void => {
    if (document.visibilityState === 'visible') void run();
  };

  document.addEventListener('visibilitychange', visible);
  void run();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    },
    now: () => { void run(); },
  };
}

export function describe(cause: unknown): string {
  if (cause instanceof RequestError && cause.status === 426) return `${cause.message}. This dashboard and the deployed Worker speak different versions of armada's wire.`;

  if (cause instanceof Error) return cause.message;

  return String(cause);
}

/** A card's empty state: what is missing, and what makes some. */
export function empty(title: string, ...hint: (string | HTMLElement)[]): HTMLElement {
  return h('div', { class: 'empty' }, h('strong', {}, title), hint.length === 0 ? null : h('div', {}, ...hint));
}
