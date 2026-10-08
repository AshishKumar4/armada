/** What the tests share to stand in for the world: a fetch a test answers, a git that sees only the repository it runs
 *  in, and a failure read as the value a test compares. */
import * as v from 'valibot';
import { errorOf } from '../src/protocol';

/** A fetch whose every request `answer` answers, in place of the network. */
export function fakeFetch(answer: (request: Request) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: string | URL | Request, init?: RequestInit) => await answer(asked(input, init)), { preconnect: () => undefined });
}

/** What fetch was asked, as a Request: Bun's constructor takes a string or a Request, and a URL as its href. */
function asked(input: string | URL | Request, init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init);

  return new Request(input instanceof URL ? input.href : input, init);
}

/** This process's environment without git's own variables. A git hook exports GIT_DIR, GIT_INDEX_FILE and others, and
 *  each outranks `cwd`, so a test's git run under a hook would act on the checkout running it. They are removed, not
 *  blanked: an empty GIT_DIR is still a GIT_DIR. */
export function gitEnv() {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && v.is(v.string(), value)) env[name] = value;
  }

  return env;
}

/** `git` in `cwd` as a test's author, with `gitEnv`, and what it printed; a git that fails throws what it said. */
export function git(cwd: string, ...args: string[]): string {
  const ran = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: gitEnv(), stdout: 'pipe', stderr: 'pipe' });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
}

/** How `work` settled: `fulfilled` when it did, else its error as `String` says it, its name and then its message. */
export async function settled(work: Promise<unknown>, fulfilled = 'fulfilled'): Promise<string> {
  try {
    await work;

    return fulfilled;
  } catch (cause) {
    return String(errorOf({ cause }));
  }
}

/** The error `work` failed with; a test that expected a failure fails when it fulfils. */
export async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return errorOf({ cause });
  }

  throw new Error('it fulfilled, where it should have failed');
}
