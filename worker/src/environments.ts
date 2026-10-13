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
import type * as v from 'valibot';
import { boundaryOf, failureTail, KEPT_ENVIRONMENTS, SIZES, workdirOf, type Commit, type EnvironmentEntrySchema, type GenerationSchema, type Recipe, type Size } from '../../src/protocol';
import { deleteSnapshotWith } from '../../src/registry';
import { AccountFull, AS_USER, EXEC_MS, instanceOf, LAUNCH_PHASE, must, type Exec, phaseDir, pipeIn, receive, run, runnerLayer, SLICE_MS, startAndAnswer, STATE, USER_HOME, WAIT_SECONDS, waitOn } from './container';
import { ArmadaSingle, packKey, said, SINGLE, type Env } from './env';
import { CAPACITY_RETRY_MS, grantOf, letGo } from './fleet';

export type Generation = v.InferOutput<typeof GenerationSchema>;

export type Entry = v.InferOutput<typeof EnvironmentEntrySchema>;

export type Readiness =
  | { readonly kind: 'ready'; readonly generation: Generation }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'failed'; readonly reason: string };

/** A preparation whose preparer has not been heard from in this long was lost: the next job asks again. Its preparer
 *  beats at each alarm (`beat`), so a phase may run as long as its own bound allows. */
const LEASE_MS = 60 * 60_000;

/** Whether `entry` is a preparation still under way at `now`. */
const preparing = (entry: Entry | undefined, now: number): entry is Extract<Entry, { readonly state: 'preparing' }> =>
  entry?.state === 'preparing' && now - (entry.beat ?? entry.since) < LEASE_MS;

/** A failed preparation is the answer for this long, so the jobs waiting on it end; then it may be asked again. */
const FAILURE_HOLD_MS = 5 * 60_000;

/** Attempts at an environment the platform, not its recipe, fails (`PlatformFailed`), each in a fresh container, before
 *  the jobs waiting on it fail: Nimbus's failed twice in three minutes on 2026-10-13 ("the container does not meet the
 *  required snapshot prerequisites") and was prepared at the next attempt. */
const PREPARE_ATTEMPTS = 3;

/** What a preparation starts from, which a fresh attempt is given again. */
type Inputs = Pick<Preparation, 'recipe' | 'sha' | 'packer' | 'shallow'>;

/** A preparation the platform failed rather than its recipe: its container would not start, the platform lost three of
 *  its execs in a row, or it would not snapshot it. */
class PlatformFailed extends Error {}

/** A snapshot no environment records any more and whose delete is still owed, under `debt:<ref>`: one a later
 *  generation of its key displaced, one a preparation made and could not publish, or one whose delete failed. `ref` is
 *  its id, or the digest a delete left once the tags were gone. */
export interface Debt {
  readonly key: string;
}

/** The environment every command runs under: the runner's defaults, then the job's own. */
export function commandEnv(recipe: Recipe, env: Readonly<Record<string, string>>) {
  const workdir = workdirOf(recipe);
  const own = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll('{workdir}', workdir)]));

  return { HOME: USER_HOME, LANG: 'C.UTF-8', CI: 'true', ARMADA: '1', ARMADA_WORKDIR: workdir, PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', ...own };
}

export class ArmadaEnvironments extends ArmadaSingle {
  /** What a client packs a commit of `history` against: the environment's commit once there is one, else the root. A
   *  shallow environment holds nothing before its commit's boundary, so a pack of `full` history, which leaves out all
   *  its base's history holds, goes from the root (#34). Asked of a ready environment, it counts as a use: the client's
   *  job opens on it once its plan and its upload are done, and no room is made from it meanwhile (`makeRoom`). */
  async base(key: string, history: 'full' | 'commit'): Promise<string> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);
    const of = (sha: string | null, shallow: boolean) => sha === null || (shallow && history === 'full') ? 'root' : sha;

    if (entry?.state === 'ready') {
      await this.ctx.storage.put(`env:${key}`, { ...entry, lastUsed: Date.now() } satisfies Entry);

      return of(entry.generation.sha, entry.generation.shallow);
    }

    return preparing(entry, Date.now()) ? of(entry.sha, entry.shallow) : 'root';
  }

  /** The key's environment, or its preparation begun; a repository recipe prepares only from a `root` pack. */
  async ensure(key: string, recipe: Recipe, commit: Commit | null, now = Date.now()): Promise<Readiness> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') {
      await this.ctx.storage.put(`env:${key}`, { ...entry, lastUsed: now } satisfies Entry);

      return { kind: 'ready', generation: entry.generation };
    }

    if (preparing(entry, now)) return { kind: 'preparing' };

    if (entry?.state === 'failed' && now - entry.at < FAILURE_HOLD_MS) return { kind: 'failed', reason: entry.reason };

    if (recipe.repo !== undefined && commit?.base !== 'root') return { kind: 'failed', reason: 'the environment this job was packed against is gone; run again, which packs from the root' };
    const shallow = recipe.repo !== undefined && commit !== null && boundaryOf(commit, recipe.repo.history).length > 0;

    return await this.attempt(key, { recipe, sha: commit?.sha ?? null, packer: commit?.packer, shallow: commit?.shallow }, { shallow, attempt: 1 }, now);
  }

  /** Attempt number `attempt` at `key`'s environment from `inputs`, begun `since`, on an object of its own, named and
   *  holding its fleet's vCPUs by `since`: one key's preparer refused every standard-4 start for 20 minutes while a new
   *  object on the same account started one at once. One whose object cannot be told to begin fails here, rather than
   *  leave its jobs waiting on a preparation no object runs. */
  private async attempt(key: string, inputs: Inputs, { shallow, attempt }: { readonly shallow: boolean; readonly attempt: number }, since: number): Promise<Readiness> {
    await this.ctx.storage.put(`env:${key}`, { state: 'preparing', sha: inputs.sha, shallow, since, attempt } satisfies Entry);

    try {
      await this.env.PREPARER.getByName(`${key}.${String(since)}`).begin(key, since, inputs);
    } catch (cause) {
      const reason = `its preparer could not begin: ${said({ cause })}`;

      await this.ctx.storage.put(`env:${key}`, { state: 'failed', at: Date.now(), reason } satisfies Entry);

      return { kind: 'failed', reason };
    }

    return { kind: 'preparing' };
  }

  /** A job that ran on the key's environment ended: its recent hour starts now. */
  async used(key: string): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'ready') await this.ctx.storage.put(`env:${key}`, { ...entry, lastUsed: Date.now() } satisfies Entry);
  }

  /** No container starts from `snapshot` any more: the platform lost it, or it was deleted under the key. The key's
   *  environment goes, so the next job prepares it again, unless the key has moved on to another snapshot since. The
   *  snapshot is owed for deletion, since its registry tags can outlive it (#20). */
  async lost(key: string, snapshot: string): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state !== 'ready' || entry.generation.snapshot.id !== snapshot) return;
    await this.forget(key);
    await this.owe(snapshot, key);
  }

  /** A new environment is ready, one more than before: the registry prunes now, and then each hour. A generation it
   *  replaces under the same key, a preparation that outlived its lease finishing after the one that replaced it, is
   *  owed for deletion. */
  async prepared(generation: Generation): Promise<void> {
    const held = await this.ctx.storage.get<Entry>(`env:${generation.key}`);

    if (held?.state === 'ready' && held.generation.snapshot.id !== generation.snapshot.id) await this.owe(held.generation.snapshot.id, generation.key);
    await this.ctx.storage.put(`env:${generation.key}`, { state: 'ready', generation, lastUsed: Date.now() } satisfies Entry);
    await this.look();
  }

  /** Each hour while an environment is ready, the snapshots past those the deployment keeps go. */
  override async alarm(): Promise<void> {
    await this.look();
  }

  /** Prunes by the deployment's retention (`prune`, which looks again in an hour). A deployment without registry
   *  credentials, which `armada deploy` mints, deletes nothing; a prune that fails leaves its snapshots for the next
   *  look. */
  private async look(): Promise<void> {
    if (this.env.REGISTRY_CREDENTIALS === undefined) return;

    try {
      await this.prune(retentionOf(this.env));
    } catch (cause) {
      console.error(JSON.stringify({ prune: said({ cause }) }));
      await this.lookAgain();
    }
  }

  /** The next look, in an hour, while an environment is ready or a snapshot's delete is owed; else none, whatever an
   *  owed delete since settled had set. */
  private async lookAgain(): Promise<void> {
    const owed = (await this.ctx.storage.list({ prefix: 'debt:', limit: 1 })).size > 0;

    if (owed || (await this.list()).some(({ entry }) => entry.state === 'ready')) await this.ctx.storage.setAlarm(Date.now() + LOOK_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  /** Deletes the snapshots of the environments past those `retention` keeps (`expired`) with the deployment's
   *  registry credentials: the account's snapshots are limited, and each change to a project's install makes another
   *  environment. Each record goes first, so a job asking for it after prepares it again rather than start from a
   *  snapshot being deleted; a snapshot whose deletion fails is logged and left. Then it looks again in an hour, so
   *  `armada deploy`'s prune starts the hourly looks. The keys pruned. */
  async prune(retention: Retention): Promise<string[]> {
    const credentials = this.env.REGISTRY_CREDENTIALS;

    if (credentials === undefined) throw new Error('this deployment has no registry credentials to delete snapshots with; armada deploy mints them');
    // Listed before the calls below let other requests in: a job admitted meanwhile is missing from `used`, but asking
    // for its environment changes that entry, which the check before each delete sees.
    const listed = await this.list();
    const used = await this.openKeys();
    const pruned: string[] = [];

    await this.settle(credentials, used);

    for (const candidate of expired(listed, used, Date.now(), retention)) {
      if (await this.evict(credentials, candidate) !== null) pruned.push(candidate.key);
    }

    await this.lookAgain();

    return pruned;
  }

  /** The account refused a snapshot of `key` for its storage (#30): this frees one snapshot of this deployment's, an
   *  owed delete first, else the least recently used environment no open job uses, past the kept count and the recent
   *  hour but not used within `IN_USE_MS`, as a client that packed against one opens its job on it (`base`). A full
   *  account fails every job that needs a new environment, which is worse than preparing an older one again. Whether a
   *  snapshot was deleted, else why none could be. */
  async makeRoom(key: string): Promise<Room> {
    const credentials = this.env.REGISTRY_CREDENTIALS;

    if (credentials === undefined) return 'no credentials';
    const listed = await this.list();
    const used = await this.openKeys();

    if (await this.settle(credentials, used)) return 'freed';

    for (const candidate of expired(listed, used, Date.now(), { keep: 0, recentMs: IN_USE_MS }).filter((each) => each.key !== key).toReversed()) {
      if (await this.evict(credentials, candidate) === true) return 'freed';
    }

    return 'held';
  }

  /** The keys open jobs use: their vessels, a replacement's included, start from those until the jobs end. */
  private async openKeys(): Promise<Set<string>> {
    const open = await this.env.FLEET.getByName(SINGLE).open();

    return new Set(await Promise.all(open.map(async (job) => await this.env.JOB.getByName(job).environment())));
  }

  /** `candidate`'s environment forgotten and its snapshot deleted: whether the delete freed it, or null when a job asked
   *  for it since it was listed, while a call let other requests in, and it stays. The read and the forgetting are
   *  storage alone, with nothing between them that lets one in. */
  private async evict(credentials: string, { key, snapshot, lastUsed }: { readonly key: string; readonly snapshot: string; readonly lastUsed: number }): Promise<boolean | null> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state !== 'ready' || entry.lastUsed !== lastUsed) return null;
    await this.forget(key);

    return await this.delete(credentials, snapshot, key);
  }

  /** A snapshot made for `key` that no environment records: a preparation's that failed after its snapshot. */
  async orphaned(snapshot: string, key: string): Promise<void> {
    await this.owe(snapshot, key);
  }

  /** Deletes the owed snapshots, but those of a key an open job uses: a job holds its generation, so a vessel it starts
   *  later may start from one its key has since replaced. Whether any was deleted. */
  private async settle(credentials: string, used: ReadonlySet<string>): Promise<boolean> {
    let freed = false;

    for (const [name, debt] of await this.ctx.storage.list<Debt>({ prefix: 'debt:' })) {
      if (used.has(debt.key)) continue;
      const ref = name.slice('debt:'.length);
      const entry = await this.ctx.storage.get<Entry>(`env:${debt.key}`);

      await this.ctx.storage.delete(name);

      // One its key records after all, a publication whose answer was lost, is that environment's, never a debt.
      if (entry?.state !== 'ready' || entry.generation.snapshot.id !== ref) freed = await this.delete(credentials, ref, debt.key) || freed;
    }

    return freed;
  }

  /** Deletes the snapshot `ref`, or owes what is left of it: the snapshot when the delete failed before its tags went,
   *  the manifest's digest, owed before any tag goes, when it failed after. Whether it is gone. */
  private async delete(credentials: string, ref: string, key: string): Promise<boolean> {
    let digest: string | undefined;

    try {
      const deleted = await deleteSnapshotWith(credentials, ref, async (found) => {
        digest = found;
        await this.owe(found, key);
      });

      if (deleted.kind === 'left') {
        console.error(JSON.stringify({ snapshot: ref, key, owed: deleted.digest, error: deleted.reason }));

        return false;
      }

      if (digest !== undefined) await this.ctx.storage.delete(`debt:${digest}`);
      console.log(JSON.stringify({ snapshot: ref, key, deleted: deleted.kind }));

      return deleted.kind === 'deleted';
    } catch (cause) {
      await this.owe(ref, key);
      console.error(JSON.stringify({ snapshot: ref, key, owed: ref, error: said({ cause }) }));

      return false;
    }
  }

  /** `ref`'s delete owed for `key`, and a look due for it, if none is: whatever path owed it, the debt is settled. */
  private async owe(ref: string, key: string): Promise<void> {
    await this.ctx.storage.put(`debt:${ref}`, { key } satisfies Debt);

    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LOOK_MS);
  }

  /** The preparation of `key` begun `since` is under way: its preparer beats, so it is not taken for lost. */
  async beat(key: string, since: number): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state === 'preparing' && entry.since === since) await this.ctx.storage.put(`env:${key}`, { ...entry, beat: Date.now() } satisfies Entry);
  }

  /** A failure ends the key's preparation only if it is the attempt begun `since`, not one a later attempt replaced. One
   *  the platform failed, which says what it started from (`again`), is attempted again in a fresh container, up to
   *  PREPARE_ATTEMPTS in all. */
  async preparationFailed(key: string, since: number, reason: string, again?: Inputs): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(`env:${key}`);

    if (entry?.state !== 'preparing' || entry.since !== since) return;
    const attempt = entry.attempt ?? 1;

    if (again !== undefined && attempt < PREPARE_ATTEMPTS) {
      console.error(JSON.stringify({ environment: key, attempt, again: reason }));

      // Begun after the attempt it replaces, if within the same millisecond, so it has an object of its own.
      await this.attempt(key, again, { shallow: entry.shallow, attempt: attempt + 1 }, Math.max(Date.now(), since + 1));

      return;
    }

    const failure = again === undefined ? reason : `${reason} (the platform failed all ${String(PREPARE_ATTEMPTS)} attempts, each in a fresh container)`;

    await this.ctx.storage.put(`env:${key}`, { state: 'failed', at: Date.now(), reason: failure } satisfies Entry);
  }

  async list(): Promise<{ key: string; entry: Entry }[]> {
    const entries = await this.ctx.storage.list<Entry>({ prefix: 'env:' });

    return [...entries].map(([name, entry]) => ({ key: name.slice('env:'.length), entry }));
  }

  /** Read-only purge inventory: deletion debts are otherwise invisible once the Worker and its namespace go. */
  async inventory(): Promise<string[]> {
    const ready = (await this.list()).flatMap(({ entry }) => entry.state === 'ready' ? [entry.generation.snapshot.id] : []);
    const debts = [...(await this.ctx.storage.list<Debt>({ prefix: 'debt:' })).keys()].map((name) => name.slice('debt:'.length));

    return [...new Set([...ready, ...debts])];
  }

  /** After `armada prune` deleted its snapshot: the next job with this key prepares again. */
  async forget(key: string): Promise<void> {
    await this.ctx.storage.delete(`env:${key}`);
  }
}

/** What `makeRoom` did: deleted a snapshot, found every one it may delete held by an open job or in use by a client
 *  (`IN_USE_MS`), or could delete none for want of registry credentials. */
export type Room = 'freed' | 'held' | 'no credentials';

/** What a prune keeps beyond the environments open jobs use: the `keep` most recently used of the rest, and each used
 *  within `recentMs`. */
export interface Retention {
  readonly keep: number;
  readonly recentMs: number;
}

/** An environment used this recently stays beyond the kept count: a busy hour's working set, larger than the count, is
 *  not prepared again for each job, and it shrinks back to the count once that hour is quiet. */
const RECENT_MS = 60 * 60_000;

/** How long making room spares an environment after its last use: `armada run` resolves its pack base again once its
 *  plan is done, and opens its job on it as soon as its uploads are, and the open job then holds it (`makeRoom`). Well
 *  within `ROOM_WAIT_MS`, so an environment used just before a refusal can still make room before the preparation
 *  fails. */
const IN_USE_MS = 10 * 60_000;

/** How often the registry looks for snapshots past those it keeps. */
const LOOK_MS = 60 * 60_000;

/** The deployment's retention: its deploy's `--keep`, and the recent hour. */
export function retentionOf({ KEEP_ENVIRONMENTS }: Pick<Env, 'KEEP_ENVIRONMENTS'>): Retention {
  return { keep: KEEP_ENVIRONMENTS === undefined ? KEPT_ENVIRONMENTS : Number(KEEP_ENVIRONMENTS), recentMs: RECENT_MS };
}

/** The ready environments a prune deletes, most recently used first: past the `keep` most recently used of those no
 *  open job `used`, each not used within `recentMs`. An open job's vessels, a replacement's included, start from its
 *  environment until it ends, so that one stays. */
export function expired(entries: readonly { readonly key: string; readonly entry: Entry }[], used: ReadonlySet<string>, now: number, { keep, recentMs }: Retention) {
  return entries.flatMap(({ key, entry }) => entry.state === 'ready' && !used.has(key) ? [{ key, snapshot: entry.generation.snapshot.id, lastUsed: entry.lastUsed }] : [])
    .toSorted((left, right) => right.lastUsed - left.lastUsed).slice(keep).filter(({ lastUsed }) => now - lastUsed >= recentMs);
}

export type Phase = 'base' | 'setup' | 'receive' | 'install' | 'snapshot';

const NEXT: Readonly<Record<Phase, Phase | null>> = { base: 'setup', setup: 'receive', receive: 'install', install: 'snapshot', snapshot: null };

export interface Preparation {
  readonly key: string;
  /** When the registry began this attempt. */
  readonly since: number;
  readonly recipe: Recipe;
  readonly sha: string | null;
  /** The packer of the commit's pack, and the shallow boundary its client sent (`CommitSchema`): absent for an earlier
   *  client's. */
  readonly packer?: number;
  readonly shallow?: readonly string[];
  readonly phase: Phase;
  /** When the phase's command was given its inputs; absent until then. */
  readonly started?: number;
  /** The execs the platform lost in a row in this phase, across its slices; absent for none. */
  readonly lost?: number;
  readonly seconds: Record<string, number>;
  readonly snapshot: Generation['snapshot'] | null;
  /** When the account first refused its snapshot for storage (`roomFor`), and why the registry last made no room;
   *  absent until then. */
  readonly refused?: number;
  readonly room?: Room | 'failed';
}

/** A phase not done yet: its alarm takes it up again in `retryInMs`. */
interface Pending {
  readonly retryInMs: number;
}

/** How the platform refuses a snapshot when the account's snapshot storage is full (armada-dew3, 2026-10-12, #30). */
const SNAPSHOT_FULL = /snapshot resource limits? (?:were|was) exceeded/iu;

/** How soon a refused snapshot is taken again, once room was asked for: a delete takes a moment to free the account. */
const ROOM_RETRY_MS = 30_000;

/** How long a preparation keeps asking for room before it fails: the jobs waiting on it wait as long. */
const ROOM_WAIT_MS = 30 * 60_000;

/** root's PATH, which the recipe's setup runs under: the tools it reaches for (locale-gen, update-alternatives) are in
 *  sbin, which the user's commands do without. Its HOME is root's too: what root writes in the user's home is root's, and
 *  the user's install then can't write there (#28). */
const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A phase's bound on `medium`, and on a smaller size in proportion to its vCPUs: the runner layer builds git, which
 *  is CPU-bound. It took 82 s on `medium` and ran past 12 min on `micro`'s half vCPU (armada-v2, 2026-10-09). */
const STEP_MS = 12 * 60_000;

const stepMs = (size: Size): number => STEP_MS * SIZES.medium.vcpus / SIZES[size].vcpus;

/** Execs in a row the platform lost before the container counts as lost, as a vessel counts them. */
const LOST_EXECS = 3;

/** A phase's command: what the container is given first, once, and what then runs, as root or as the user. */
interface Command {
  readonly doing: string;
  readonly inputs: () => Promise<void>;
  readonly argv: readonly string[];
  readonly asUser: boolean;
  /** Its environment; the container's own where absent. */
  readonly env?: Record<string, string>;
  /** Where it runs: the work directory, once the runner's layer has made it. */
  readonly cwd?: string;
}

/** The fleet's holder of a preparation's container: its own, apart from every job's and every other attempt's at the
 *  same environment, whose container may outlive it (`end`). */
const holderOf = ({ key, since }: Pick<Preparation, 'key' | 'since'>): string => `preparing/${key}/${String(since)}`;

/** The most a preparation can run: each phase within its bound, and the snapshot refused for want of room as long as it
 *  may be. Its container's hold in the fleet lasts this long, past which the container is gone. */
const preparationMs = (size: Size): number => Object.keys(NEXT).length * stepMs(size) + ROOM_WAIT_MS;

export class ArmadaPreparer extends DurableObject<Env> {
  async begin(key: string, since: number, { recipe, sha, packer, shallow }: Pick<Preparation, 'recipe' | 'sha' | 'packer' | 'shallow'>): Promise<void> {
    await this.ctx.storage.put('preparation', { key, since, recipe, sha, packer, shallow, phase: 'base', seconds: {}, snapshot: null } satisfies Preparation);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    const preparation = await this.ctx.storage.get<Preparation>('preparation');

    if (preparation === undefined) return;
    await this.env.ENVIRONMENTS.getByName(SINGLE).beat(preparation.key, preparation.since);
    const began = Date.now();
    // The snapshot once one is made, so a preparation that fails after it owes it rather than lose it.
    let made = preparation.snapshot;

    try {
      // Its container starts once the fleet has room for it, as every job's does, and holds it to the end.
      if (preparation.phase === 'base' && preparation.started === undefined) {
        const granted = await this.env.FLEET.getByName(SINGLE).acquire(holderOf(preparation), SIZES[preparation.recipe.size].vcpus, { deadlineAt: preparation.since + preparationMs(preparation.recipe.size) });

        if (grantOf(granted) === null) return await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);
      }

      const step = await this.step(preparation);

      if ('retryInMs' in step) return await this.ctx.storage.setAlarm(Date.now() + step.retryInMs);
      made = step.snapshot ?? made;
      const seconds = { ...preparation.seconds, [preparation.phase]: (Date.now() - (preparation.started ?? began)) / 1000 };
      const next = NEXT[preparation.phase];
      // A new phase starts with no lost exec counted, as with no start: its execs are its own.
      const advanced = { ...preparation, seconds, started: undefined, lost: undefined, snapshot: step.snapshot ?? preparation.snapshot };

      if (next === null) return await this.done(advanced);
      await this.ctx.storage.put('preparation', { ...advanced, phase: next } satisfies Preparation);
      await this.ctx.storage.setAlarm(Date.now());
    } catch (cause) {
      // The account had no room for its container: its hold goes back, and it asks the fleet again in a moment.
      if (cause instanceof AccountFull) {
        await letGo(this.ctx, this.env, { holder: holderOf(preparation), inactivityMs: LEASE_MS });

        return await this.ctx.storage.setAlarm(Date.now() + CAPACITY_RETRY_MS);
      }

      await this.ctx.storage.delete('preparation');
      // The preparation failed already, whatever its container does.
      await letGo(this.ctx, this.env, { holder: holderOf(preparation), inactivityMs: LEASE_MS });
      console.error(JSON.stringify({ preparation: preparation.key, phase: preparation.phase, error: said({ cause }) }));

      if (made !== null) await this.env.ENVIRONMENTS.getByName(SINGLE).orphaned(made.id, preparation.key);
      const { recipe, sha, packer, shallow } = preparation;

      await this.env.ENVIRONMENTS.getByName(SINGLE).preparationFailed(preparation.key, preparation.since, `${preparation.phase}: ${said({ cause })}`, cause instanceof PlatformFailed ? { recipe, sha, packer, shallow } : undefined);
    }
  }

  /** One phase done (with the snapshot once there is one), or how soon to take it up again: at once for a command that
   *  still runs, in a moment for a snapshot the account refused. */
  private async step(preparation: Preparation): Promise<Pending | { readonly snapshot?: Generation['snapshot'] }> {
    const { recipe } = preparation;
    const container = this.container();
    const workdir = workdirOf(recipe);
    const env = commandEnv(recipe, {});

    switch (preparation.phase) {
      case 'base':
        return await this.command(preparation, {
          doing: 'the runner layer', asUser: false, argv: ['/bin/sh', '-c', runnerLayer(workdir)],
          inputs: async () => {
            try {
              await startAndAnswer(container, { image: recipe.base, instance: instanceOf(recipe.size), enableInternet: true, entrypoint: ['sleep', 'infinity'] }, { ms: 300_000, inactivityMs: LEASE_MS });
            } catch (cause) {
              if (cause instanceof AccountFull) throw cause;

              throw new PlatformFailed('the container would not start', { cause });
            }
          },
        });

      case 'setup':
        return recipe.setup === '' ? {} : await this.command(preparation, {
          doing: 'the recipe\'s setup', asUser: false, env: { ...env, PATH: ROOT_PATH, HOME: '/root' }, cwd: workdir, argv: ['/bin/sh', `${STATE}/setup.sh`],
          inputs: async () => { await pipeIn(container, recipe.setup, `${STATE}/setup.sh`); },
        });

      case 'receive': {
        const { repo } = recipe;
        const { sha } = preparation;

        return repo === undefined || sha === null ? {} : await this.command(preparation, {
          doing: 'the checkout', asUser: true, env, cwd: workdir, argv: ['/bin/sh', '-c', receive(workdir), 'receive', sha, ...boundaryOf({ sha, shallow: preparation.shallow }, repo.history)],
          inputs: async () => {
            const pack = await this.env.ARTIFACTS.get(await packKey(repo.project, { sha, base: 'root', packer: preparation.packer, shallow: preparation.shallow }));

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
        const [taken] = await Promise.allSettled([container.snapshotContainer({ name: `armada-${preparation.key.slice(0, 20)}` })]);

        if (taken.status === 'rejected') {
          const refusal = said({ cause: taken.reason });

          if (!SNAPSHOT_FULL.test(refusal)) throw new PlatformFailed(refusal);

          return await this.roomFor(preparation, refusal);
        }


        return { snapshot: { id: taken.value.id, size: taken.value.size } };
      }
    }
  }

  /** The account's snapshot storage is full: the registry frees what this deployment can (`makeRoom`), and the snapshot
   *  is taken again in a moment from the same container, while the jobs waiting on it wait on. Refused for
   *  `ROOM_WAIT_MS`, the preparation fails and says what holds the storage. */
  private async roomFor(preparation: Preparation, refusal: string): Promise<Pending> {
    const refused = preparation.refused ?? Date.now();

    if (Date.now() - refused >= ROOM_WAIT_MS) {
      const minutes = String(ROOM_WAIT_MS / 60_000);

      throw new Error(preparation.room === 'no credentials'
        ? `${refusal} It was refused for ${minutes} min, and this deployment has no registry credentials to delete its own snapshots with (armada deploy mints them)`
        : `${refusal} It was refused for ${minutes} min while this deployment deleted the snapshots it could: the rest of the account's snapshot storage is held by open jobs, runs in the last ${String(IN_USE_MS / 60_000)} min, other deployments or other apps (armada prune on another deployment, or a higher limit from Cloudflare, makes room)`);
    }

    // Kept before the registry is asked, so a failed ask still counts toward the bound.
    await this.ctx.storage.put('preparation', { ...preparation, refused } satisfies Preparation);
    let room: Room | 'failed';

    try {
      room = await this.env.ENVIRONMENTS.getByName(SINGLE).makeRoom(preparation.key);
    } catch (cause) {
      // Asking again next time is the answer to an ask that failed: the container is still worth its snapshot.
      room = 'failed';
      console.error(JSON.stringify({ preparation: preparation.key, makingRoom: said({ cause }) }));
    }

    console.log(JSON.stringify({ preparation: preparation.key, refused: refusal, room }));
    await this.ctx.storage.put('preparation', { ...preparation, refused, room } satisfies Preparation);

    return { retryInMs: ROOM_RETRY_MS };
  }

  /** A phase's command, run once in its container whatever alarms see it: the first gives the container its inputs and
   *  launches the command detached, and each waits on it for a slice. A launch or a wait whose exec the platform lost is
   *  made again; three lost in a row, in one slice or across them, and the container is lost. Past its bound, the phase
   *  fails, however its execs went. */
  private async command(preparation: Preparation, { doing, inputs, argv, asUser, env, cwd }: Command): Promise<Pending | Record<string, never>> {
    const container = this.container();
    const dir = phaseDir(preparation.phase);
    let { started } = preparation;

    if (started === undefined) {
      await inputs();
      started = Date.now();
      await this.ctx.storage.put('preparation', { ...preparation, started } satisfies Preparation);
    }

    let lost = preparation.lost ?? 0;

    // An exec's output, or null where the platform lost it and it is to be made again.
    const attempt = async (what: string, exec: readonly string[], options: Exec): Promise<string | null> => {
      const [answered] = await Promise.allSettled([run(container, exec, options)]);

      if (answered.status === 'rejected') {
        lost += 1;

        if (lost >= LOST_EXECS) throw new PlatformFailed(`${what} failed to run`, { cause: answered.reason });
        await this.ctx.storage.put('preparation', { ...preparation, started, lost } satisfies Preparation);

        return null;
      }

      if (answered.value.exitCode !== 0) throw new Error(`${what} exited ${String(answered.value.exitCode)}: ${failureTail(answered.value.stdout, answered.value.stderr)}`);

      return answered.value.stdout.trim();
    };

    const until = Date.now() + SLICE_MS;

    while (Date.now() < until) {
      if (Date.now() - started > stepMs(preparation.recipe.size)) throw new Error(`${doing} ran longer than ${String(stepMs(preparation.recipe.size) / 60_000)} min`);

      if ((await attempt(`launching ${doing}`, ['/bin/sh', '-c', LAUNCH_PHASE, 'launch', preparation.phase, ...asUser ? AS_USER : [], ...argv], { env, cwd, ms: EXEC_MS })) === null) continue;
      const exit = await attempt('the wait', ['/bin/sh', '-c', waitOn(dir), 'wait', String(WAIT_SECONDS)], { ms: (WAIT_SECONDS + 30) * 1000 });

      if (exit === null) continue;

      if (lost > 0) {
        lost = 0;
        await this.ctx.storage.put('preparation', { ...preparation, started, lost } satisfies Preparation);
      }

      if (exit === '0') return {};

      if (exit !== '') throw new Error(`${doing} exited ${exit}: ${(await run(container, ['tail', '-c', '3000', `${dir}/log`], { ms: EXEC_MS })).stdout}`);
    }

    return { retryInMs: 0 };
  }

  private async done(preparation: Preparation): Promise<void> {
    if (preparation.snapshot === null) throw new Error('a finished preparation has no snapshot');
    await this.ctx.storage.delete('preparation');
    // Made, the snapshot is the environment, whatever its container does.
    await letGo(this.ctx, this.env, { holder: holderOf(preparation), inactivityMs: LEASE_MS });
    const { recipe: { repo }, sha } = preparation;
    const shallow = repo !== undefined && sha !== null && boundaryOf({ sha, shallow: preparation.shallow }, repo.history).length > 0;

    await this.env.ENVIRONMENTS.getByName(SINGLE).prepared({ key: preparation.key, snapshot: preparation.snapshot, sha, shallow, created: Date.now(), seconds: preparation.seconds });
  }

  private container(): Container {
    if (this.ctx.container === undefined) throw new Error('ArmadaPreparer has no container binding');

    return this.ctx.container;
  }
}
