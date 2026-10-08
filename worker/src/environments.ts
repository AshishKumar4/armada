/**
 * One environment per `environmentKey`: a container snapshot of the recipe's base with the runner's layer, the
 * recipe's `setup` run as root, any commit checked out, and the recipe's `install` run as the user, from which every
 * container of every job with that key starts. ArmadaEnvironments is the account's one registry of them;
 * ArmadaPreparer, one per key, builds one a phase at a time. A phase's command runs detached, once per container, and
 * alarms wait on it a slice at a time, as a vessel waits on a task: an alarm the platform delivers again takes the
 * phase up rather than running it twice, and an exec the platform loses is a wait to make again.
 * The key hashes the recipe's own text and the driver, so a fixed recipe or runner layer is a new environment, never an
 * old snapshot trusted for weeks.
 */
import { DurableObject } from 'cloudflare:workers';
import { failureTail, workdirOf, type Recipe } from '../../src/protocol';
import { deleteSnapshotWith } from '../../src/registry';
import { AS_USER, instanceOf, LAUNCH_PHASE, must, type Exec, phaseDir, pipeIn, receive, run, runnerLayer, startAndAnswer, STATE, waitOn } from './container';
import { packKey, said, SINGLE, type Env } from './env';

/** An environment snapshot: what every container with its key starts from. */
export interface Generation {
  readonly key: string;
  readonly snapshot: { readonly id: string; readonly size: number };
  /** The commit whose checkout and install it holds, for a repository recipe. */
  readonly sha: string | null;
  readonly created: number;
  /** Seconds each preparation phase took. */
  readonly seconds: Record<string, number>;
}

type Entry =
  | { readonly state: 'preparing'; readonly sha: string | null; readonly since: number }
  | { readonly state: 'ready'; readonly generation: Generation; readonly lastUsed: number }
  | { readonly state: 'failed'; readonly at: number; readonly reason: string };

export type Readiness =
  | { readonly kind: 'ready'; readonly generation: Generation }
  | { readonly kind: 'preparing'; readonly since: number }
  | { readonly kind: 'failed'; readonly reason: string };

/** A preparation still unfinished after this was lost: the next job asks again. */
const LEASE_MS = 60 * 60_000;

/** A failed preparation is the answer for this long, so the jobs waiting on it end; then it may be asked again. */
const FAILURE_HOLD_MS = 5 * 60_000;

/** The environment every command runs under: the runner's defaults, then the job's own. */
export function commandEnv(recipe: Recipe, env: Readonly<Record<string, string>>): Record<string, string> {
  const workdir = workdirOf(recipe);
  const own = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('{workdir}', workdir)]));

  return { HOME: '/home/ci', LANG: 'C.UTF-8', CI: 'true', ARMADA: '1', ARMADA_WORKDIR: workdir, PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', ...own };
}

export class ArmadaEnvironments extends DurableObject<Env> {
  /** What a client packs a commit against: the environment's commit once there is one, else the root. */
  async base(key: string): Promise<string> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') return entry.generation.sha ?? 'root';

    return entry?.state === 'preparing' && Date.now() - entry.since < LEASE_MS ? entry.sha ?? 'root' : 'root';
  }

  /** The key's environment, or its preparation begun; a repository recipe prepares only from a `root` pack. */
  async ensure(key: string, recipe: Recipe, commit: { readonly sha: string; readonly base: string; readonly packer?: number } | null, now = Date.now()): Promise<Readiness> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') {
      await this.ctx.storage.put(`env:${key}`, { ...entry, lastUsed: now } satisfies Entry);

      return { kind: 'ready', generation: entry.generation };
    }

    if (entry?.state === 'preparing' && now - entry.since < LEASE_MS) return { kind: 'preparing', since: entry.since };

    if (entry?.state === 'failed' && now - entry.at < FAILURE_HOLD_MS) return { kind: 'failed', reason: entry.reason };

    if (recipe.repo !== undefined && commit?.base !== 'root') return { kind: 'failed', reason: 'the environment this job was packed against is gone; run again, which packs from the root' };
    await this.ctx.storage.put(`env:${key}`, { state: 'preparing', sha: commit?.sha ?? null, since: now } satisfies Entry);
    // Each attempt on its own object: one key's preparer refused every standard-4 start for 20 minutes while a new
    // object on the same account started one at once.
    await this.env.PREPARER.getByName(`${key}.${String(now)}`).begin(key, now, recipe, commit?.sha ?? null, commit?.packer);

    return { kind: 'preparing', since: now };
  }

  /** With `armada deploy --keep=N`, a new environment prunes the ones past it (`prune`). */
  async prepared(generation: Generation): Promise<void> {
    await this.ctx.storage.put(`env:${generation.key}`, { state: 'ready', generation, lastUsed: Date.now() } satisfies Entry);
    const keep = Number(this.env.KEEP_ENVIRONMENTS ?? 0);

    if (keep > 0 && this.env.REGISTRY_CREDENTIALS !== undefined) {
      await this.prune(keep, this.env.REGISTRY_CREDENTIALS).catch((cause: unknown) => { console.error(JSON.stringify({ prune: said(cause) })); });
    }
  }

  /** Deletes the snapshots of the ready environments past every one an open job uses and the `keep` most recently
   *  used of the rest, with the registry `credentials`: the account's snapshots are limited, and each change to a
   *  project's install makes another environment. Each record goes first, so a job asking for it after prepares it
   *  again rather than start from a snapshot being deleted; a snapshot whose deletion fails is logged and left. The keys
   *  pruned. */
  async prune(keep: number, credentials: string): Promise<string[]> {
    const open = await this.env.FLEET.getByName(SINGLE).open();
    const used = new Set(await Promise.all(open.map(async (job) => await this.env.JOB.getByName(job).environment())));
    const pruned: string[] = [];

    for (const { key, snapshot } of superseded(await this.list(), keep, used)) {
      await this.forget(key);
      pruned.push(key);

      try {
        console.log(JSON.stringify({ pruned: key, snapshot: await deleteSnapshotWith(credentials, snapshot) }));
      } catch (cause) {
        console.error(JSON.stringify({ pruned: key, snapshot, left: said(cause) }));
      }
    }

    return pruned;
  }

  /** A failure ends the key's preparation only if it is the attempt begun `since`, not one a later attempt replaced. */
  async preparationFailed(key: string, since: number, reason: string): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state !== 'preparing' || entry.since !== since) return;
    await this.ctx.storage.put(`env:${key}`, { state: 'failed', at: Date.now(), reason } satisfies Entry);
  }

  async list(): Promise<{ key: string; entry: Entry }[]> {
    const entries = await this.ctx.storage.list<Entry>({ prefix: 'env:' });

    return [...entries].map(([name, entry]) => ({ key: name.slice('env:'.length), entry }));
  }

  /** After `armada prune` deleted its snapshot: the next job with this key prepares again. */
  async forget(key: string): Promise<void> {
    await this.ctx.storage.delete(`env:${key}`);
  }
}

/** The ready environments that no open job `used` and that are past the `keep` most recently used of those, oldest
 *  last: an open job's vessels, a replacement's included, start from its environment until it ends. */
export function superseded(entries: readonly { readonly key: string; readonly entry: Entry }[], keep: number, used: ReadonlySet<string>): { key: string; snapshot: string }[] {
  return entries.flatMap(({ key, entry }) => entry.state === 'ready' && !used.has(key) ? [{ key, lastUsed: entry.lastUsed, snapshot: entry.generation.snapshot.id }] : [])
    .sort((left, right) => right.lastUsed - left.lastUsed).slice(keep).map(({ key, snapshot }) => ({ key, snapshot }));
}

type Phase = 'base' | 'setup' | 'receive' | 'install' | 'snapshot';

const NEXT: Readonly<Record<Phase, Phase | null>> = { base: 'setup', setup: 'receive', receive: 'install', install: 'snapshot', snapshot: null };

interface Preparation {
  readonly key: string;
  /** When the registry began this attempt. */
  readonly since: number;
  readonly recipe: Recipe;
  readonly sha: string | null;
  /** The packer of the commit's pack: absent for an earlier client's. */
  readonly packer?: number;
  readonly phase: Phase;
  /** When the phase's command was given its inputs; absent until then. */
  readonly started?: number;
  readonly seconds: Record<string, number>;
  readonly snapshot: Generation['snapshot'] | null;
}

/** root's PATH, which the recipe's setup runs under: the tools it reaches for (locale-gen, update-alternatives) are in
 *  sbin, which the user's commands do without. */
const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A phase's bound. */
const STEP_MS = 12 * 60_000;

const EXEC_MS = 90_000;

/** One alarm's share of a phase; the next alarm takes it up at once. */
const SLICE_MS = 50_000;

/** One blocking wait on a running phase. */
const WAIT_SECONDS = 20;

/** Execs in a row the platform lost before the container counts as lost, as a vessel counts them. */
const LOST_EXECS = 3;

/** A phase's command: what the container is given first, once, and what then runs, as root or as the user. */
interface Command {
  readonly doing: string;
  readonly inputs: () => Promise<unknown>;
  readonly argv: readonly string[];
  readonly asUser: boolean;
  /** Its environment; the container's own where absent. */
  readonly env?: Record<string, string>;
  /** Where it runs: the work directory, once the runner's layer has made it. */
  readonly cwd?: string;
}

export class ArmadaPreparer extends DurableObject<Env> {
  async begin(key: string, since: number, recipe: Recipe, sha: string | null, packer?: number): Promise<void> {
    await this.ctx.storage.put('preparation', { key, since, recipe, sha, packer, phase: 'base', seconds: {}, snapshot: null } satisfies Preparation);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const preparation = await this.ctx.storage.get<Preparation>('preparation');

    if (preparation === undefined) return;
    const began = Date.now();

    try {
      const step = await this.step(preparation);

      if (step === 'running') return await this.ctx.storage.setAlarm(Date.now());
      const seconds = { ...preparation.seconds, [preparation.phase]: (Date.now() - (preparation.started ?? began)) / 1000 };
      const next = NEXT[preparation.phase];
      const advanced = { ...preparation, seconds, started: undefined, snapshot: step.snapshot ?? preparation.snapshot };

      if (next === null) return await this.done(advanced);
      await this.ctx.storage.put('preparation', { ...advanced, phase: next } satisfies Preparation);
      await this.ctx.storage.setAlarm(Date.now());
    } catch (cause) {
      await this.ctx.storage.delete('preparation');
      // The preparation failed already; a container that will not stop ends at its inactivity timeout.
      await Promise.allSettled([this.ctx.container?.destroy()]);
      console.error(JSON.stringify({ preparation: preparation.key, phase: preparation.phase, error: said(cause) }));
      await this.registry().preparationFailed(preparation.key, preparation.since, `${preparation.phase}: ${said(cause)}`);
    }
  }

  /** One phase, or a slice of one whose command still runs; the snapshot once there is one. */
  private async step(preparation: Preparation): Promise<'running' | { readonly snapshot?: Generation['snapshot'] }> {
    const { recipe } = preparation;
    const container = this.container();
    const workdir = workdirOf(recipe);
    const env = commandEnv(recipe, {});

    switch (preparation.phase) {
      case 'base':
        return await this.command(preparation, {
          doing: 'the runner layer', asUser: false, argv: ['/bin/sh', '-c', runnerLayer(workdir)],
          inputs: async () => { await startAndAnswer(container, { image: recipe.base, instance: instanceOf(recipe.size), enableInternet: true, entrypoint: ['sleep', 'infinity'] }, 300_000, LEASE_MS); },
        });

      case 'setup':
        return recipe.setup === '' ? {} : await this.command(preparation, {
          doing: 'the recipe\'s setup', asUser: false, env: { ...env, PATH: ROOT_PATH }, cwd: workdir, argv: ['/bin/sh', `${STATE}/setup.sh`],
          inputs: async () => { await pipeIn(container, recipe.setup, `${STATE}/setup.sh`); },
        });

      case 'receive': {
        const { repo } = recipe;
        const { sha } = preparation;

        return repo === undefined || sha === null ? {} : await this.command(preparation, {
          doing: 'the checkout', asUser: true, env, cwd: workdir, argv: ['/bin/sh', '-c', receive(workdir, repo.history), 'receive', sha],
          inputs: async () => {
            const pack = await this.env.ARTIFACTS.get(packKey(repo.project, sha, 'root', preparation.packer));

            if (pack === null) throw new Error(`the pack of ${sha} is not in R2`);
            await pipeIn(container, pack.body, `${STATE}/pack`);
          },
        });
      }

      case 'install':
        return recipe.install === '' ? {} : await this.command(preparation, {
          doing: 'the recipe\'s install', asUser: true, env, cwd: workdir, argv: ['/bin/sh', `${STATE}/install.sh`],
          inputs: async () => { await pipeIn(container, recipe.install, `${STATE}/install.sh`); },
        });

      case 'snapshot': {
        // The phases' logs stay out of the environment.
        await must(container, 'clearing the phases', ['rm', '-rf', `${STATE}/phases`], { ms: EXEC_MS });
        const snapshot = await container.snapshotContainer({ name: `armada-${preparation.key.slice(0, 20)}` });

        await container.destroy();

        return { snapshot: { id: snapshot.id, size: snapshot.size } };
      }
    }
  }

  /** A phase's command, run once in its container whatever alarms see it: the first gives the container its inputs and
   *  launches the command detached, and each waits on it for a slice. A launch or a wait whose exec the platform lost is
   *  made again; three lost in a row, and the container is lost. */
  private async command(preparation: Preparation, { doing, inputs, argv, asUser, env, cwd }: Command): Promise<'running' | Record<string, never>> {
    const container = this.container();
    const dir = phaseDir(preparation.phase);
    let { started } = preparation;

    if (started === undefined) {
      await inputs();
      started = Date.now();
      await this.ctx.storage.put('preparation', { ...preparation, started } satisfies Preparation);
    }

    let lost = 0;
    // An exec's output, or null where the platform lost it and it is to be made again.
    const attempt = async (what: string, exec: readonly string[], options: Exec): Promise<string | null> => {
      const [answered] = await Promise.allSettled([run(container, exec, options)]);

      if (answered.status === 'rejected') {
        lost += 1;

        if (lost < LOST_EXECS) return null;
        throw new Error(`${what} failed to run`, { cause: answered.reason });
      }

      if (answered.value.exitCode !== 0) throw new Error(`${what} exited ${String(answered.value.exitCode)}: ${failureTail(answered.value.stdout, answered.value.stderr)}`);

      return answered.value.stdout.trim();
    };
    const until = Date.now() + SLICE_MS;

    while (Date.now() < until) {
      if ((await attempt(`launching ${doing}`, ['/bin/sh', '-c', LAUNCH_PHASE, 'launch', preparation.phase, ...asUser ? AS_USER : [], ...argv], { env, cwd, ms: EXEC_MS })) === null) continue;
      const exit = await attempt('the wait', ['/bin/sh', '-c', waitOn(dir), 'wait', String(WAIT_SECONDS)], { ms: (WAIT_SECONDS + 30) * 1000 });

      if (exit === null) continue;
      lost = 0;

      if (exit === '0') return {};

      if (exit !== '') throw new Error(`${doing} exited ${exit}: ${(await run(container, ['tail', '-c', '3000', `${dir}/log`], { ms: EXEC_MS })).stdout}`);

      if (Date.now() - started > STEP_MS) throw new Error(`${doing} ran longer than ${String(STEP_MS / 60_000)} min`);
    }

    return 'running';
  }

  private async done(preparation: Preparation): Promise<void> {
    if (preparation.snapshot === null) throw new Error('a finished preparation has no snapshot');
    await this.ctx.storage.delete('preparation');
    await this.registry().prepared({ key: preparation.key, snapshot: preparation.snapshot, sha: preparation.sha, created: Date.now(), seconds: preparation.seconds });
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('ArmadaPreparer has no container binding');

    return this.ctx.container;
  }

  private registry() {
    return this.env.ENVIRONMENTS.getByName(SINGLE);
  }
}
