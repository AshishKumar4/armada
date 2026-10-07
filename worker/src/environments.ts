/**
 * One environment per `environmentKey`: a container snapshot of the recipe's base with the runner's layer, the
 * recipe's `setup` run as root, any commit checked out, and the recipe's `install` run as the user, from which every
 * container of every job with that key starts. ArmadaEnvironments is the account's one registry of them;
 * ArmadaPreparer, one per key, builds one a phase per alarm (each exec bounded inside the platform's 15-minute alarm),
 * as Dew's SnapshotPreparer and Kinu's devbox golden do. The key hashes the recipe's own text and the driver, so a
 * fixed recipe or runner layer is a new environment, never an old snapshot trusted for weeks.
 */
import { DurableObject } from 'cloudflare:workers';
import { workdirOf, type Recipe } from '../../src/protocol';
import { ENTRYPOINT, must, pipeIn, receive, runnerLayer, startAndAnswer, STATE } from './container';
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

  async prepared(generation: Generation): Promise<void> {
    await this.ctx.storage.put(`env:${generation.key}`, { state: 'ready', generation, lastUsed: Date.now() } satisfies Entry);
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

type Phase = 'base' | 'setup' | 'receive' | 'install' | 'snapshot' | 'verify';

const NEXT: Readonly<Record<Phase, Phase | null>> = { base: 'setup', setup: 'receive', receive: 'install', install: 'snapshot', snapshot: 'verify', verify: null };

interface Preparation {
  readonly key: string;
  /** When the registry began this attempt. */
  readonly since: number;
  readonly recipe: Recipe;
  readonly sha: string | null;
  /** The packer of the commit's pack: absent for an earlier client's. */
  readonly packer?: number;
  readonly phase: Phase;
  readonly seconds: Record<string, number>;
  readonly snapshot: Generation['snapshot'] | null;
}

/** root's PATH, which the recipe's setup runs under: the tools it reaches for (locale-gen, update-alternatives) are in
 *  sbin, which the user's commands do without. */
const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** An exec's bound inside one alarm, which the platform ends at 15 minutes. */
const STEP_MS = 12 * 60_000;

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
      const snapshot = await this.step(preparation);
      const seconds = { ...preparation.seconds, [preparation.phase]: (Date.now() - began) / 1000 };
      const next = NEXT[preparation.phase];
      const advanced = { ...preparation, seconds, snapshot: snapshot ?? preparation.snapshot };

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

  /** One phase; the snapshot once there is one. */
  private async step(preparation: Preparation): Promise<Generation['snapshot'] | undefined> {
    const { recipe } = preparation;
    const container = this.container();
    const workdir = workdirOf(recipe);
    const asUser = { asUser: true, env: commandEnv(recipe, {}), cwd: workdir, ms: STEP_MS };

    switch (preparation.phase) {
      case 'base': {
        await startAndAnswer(container, { image: recipe.base, instance: recipe.instance, enableInternet: true, entrypoint: ['sleep', 'infinity'] }, 300_000, LEASE_MS);
        await must(container, 'the runner layer', ['/bin/sh', '-c', runnerLayer(workdir)], { ms: STEP_MS });

        return undefined;
      }

      case 'setup': {
        if (recipe.setup === '') return undefined;
        await pipeIn(container, recipe.setup, `${STATE}/setup.sh`);
        await must(container, 'the recipe\'s setup', ['/bin/sh', `${STATE}/setup.sh`], { env: { ...commandEnv(recipe, {}), PATH: ROOT_PATH }, cwd: workdir, ms: STEP_MS });

        return undefined;
      }

      case 'receive': {
        if (recipe.repo === undefined || preparation.sha === null) return undefined;
        const pack = await this.env.ARTIFACTS.get(packKey(recipe.repo.project, preparation.sha, 'root', preparation.packer));

        if (pack === null) throw new Error(`the pack of ${preparation.sha} is not in R2`);
        await pipeIn(container, pack.body, `${STATE}/pack`);
        await must(container, 'the checkout', ['/bin/sh', '-c', receive(workdir, recipe.repo.history), 'receive', preparation.sha], asUser);

        return undefined;
      }

      case 'install': {
        if (recipe.install === '') return undefined;
        await pipeIn(container, recipe.install, `${STATE}/install.sh`);
        await must(container, 'the recipe\'s install', ['/bin/sh', `${STATE}/install.sh`], asUser);

        return undefined;
      }

      case 'snapshot': {
        const snapshot = await container.snapshotContainer({ name: `armada-${preparation.key.slice(0, 20)}` });

        await container.destroy();

        return { id: snapshot.id, size: snapshot.size };
      }

      case 'verify': {
        if (preparation.snapshot === null) throw new Error('verifying a preparation that has no snapshot');
        // A snapshot that does not start, or starts without what it was given, is no environment.
        await startAndAnswer(container, { containerSnapshot: { id: preparation.snapshot.id }, instance: recipe.instance, enableInternet: true, entrypoint: ENTRYPOINT }, 300_000, LEASE_MS);
        await must(container, 'the restored environment', ['/bin/sh', '-c', recipe.repo === undefined ? 'true' : 'git rev-parse HEAD'], asUser);

        if (recipe.smoke !== '') await must(container, 'the recipe\'s smoke', ['/bin/sh', '-c', recipe.smoke], asUser);
        await container.destroy();

        return undefined;
      }
    }
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
