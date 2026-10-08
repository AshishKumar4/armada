/** A page of the dashboard, and how it stays current: it polls while it is shown and stops when it is left. */
import { detach, errorOf } from '../../src/protocol';
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

/** A page's poll: stopped when the page is left, run again at once on request. */
export interface Poller {
  stop(): void;
  now(): void;
}

/** Runs `refresh` now and then every `ms` after each run ends, while the page is visible, until `stop`. A failure is
 *  shown in `banner` and the next run tries again; a refused bearer signs out. `refresh` answers whether to go on. */
export function poll(ms: number, banner: HTMLElement, refresh: () => Promise<boolean>): Poller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const shown = (error: Error): void => { failed(banner, error); };

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

      shown(errorOf({ cause }));
    } finally {
      running = false;
    }

    if (!stopped && again && document.visibilityState === 'visible') timer = setTimeout(kick, ms);
  };

  function kick(): void {
    detach(run(), shown);
  }

  const visible = (): void => {
    if (document.visibilityState === 'visible') kick();
  };

  document.addEventListener('visibilitychange', visible);
  kick();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    },
    now: kick,
  };
}

/** A failure shown in a page's banner. */
export function failed(banner: HTMLElement, error: Error): void {
  replace(banner, h('div', { class: 'error-banner' }, icon('alert'), describe(error)));
}

/** What a failed request says, in words for the page. */
export function describe(error: Error): string {
  if (error instanceof RequestError && error.status === 426) return `${error.message}. This dashboard and the deployed Worker speak different versions of armada's wire.`;

  return error.message;
}

/** A card's empty state: what is missing, and what makes some. */
export function empty(title: string, ...hint: (string | HTMLElement)[]): HTMLElement {
  return h('div', { class: 'empty' }, h('strong', {}, title), hint.length === 0 ? null : h('div', {}, ...hint));
}
