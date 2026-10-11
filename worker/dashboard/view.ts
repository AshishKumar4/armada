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

/** A page's poll, which `stop` ends when the page is left. */
export interface Poller {
  stop(): void;
}

/** Runs `refresh` now and then every `ms` after each run ends, while the page is visible, until `stop`. A failure is
 *  shown in `banner` and the next run tries again; a refused bearer signs out. `refresh` answers whether to go on.
 *  `stop` aborts the `signal` `refresh` gets, so a run under way when the page is left changes nothing. */
export function poll(ms: number, banner: HTMLElement, refresh: (signal: AbortSignal) => Promise<boolean>): Poller {
  const left = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const shown = (error: Error): void => { failed(banner, error); };

  const run = async (): Promise<void> => {
    clearTimeout(timer);

    if (left.signal.aborted || running) return;
    running = true;
    let again = true;

    try {
      again = await refresh(left.signal);

      if (left.signal.aborted) return;
      replace(banner);
    } catch (cause) {
      if (left.signal.aborted) return;

      if (cause instanceof SignedOut) {
        left.abort();
        onSignedOut();

        return;
      }

      shown(errorOf({ cause }));
    } finally {
      running = false;
    }

    if (!left.signal.aborted && again && document.visibilityState === 'visible') timer = setTimeout(kick, ms);
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
      left.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    },
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
