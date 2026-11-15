import * as v from 'valibot';

/** A job a deployment lists (`GET /jobs`) as a Worker of any wire since the drain answers it: its id, label, phase
 *  and, where it says it, when it was made. */
export const ListedJobSchema = v.object({
  id: v.string(),
  label: v.optional(v.string(), ''),
  phase: v.picklist(['preparing', 'running', 'done']),
  createdAt: v.optional(v.number()),
});

export type ListedJob = v.InferOutput<typeof ListedJobSchema>;

/** The most jobs one page of `GET /jobs` holds. */
const PAGE = 100;

/** Why a listing of open jobs could not be read whole: no Worker answers `GET /jobs`, or its pages repeated an id. */
export class Unlisted extends Error {
  override readonly name = 'Unlisted';

  constructor(readonly kind: 'unavailable' | 'repeated') {
    super(kind === 'unavailable' ? 'GET /jobs is unavailable' : 'GET /jobs repeated an id while paging');
  }
}

/** Every job of a deployment that is not done, each page of `GET /jobs` read through `call` (a path to its answer);
 *  a listing it cannot complete is refused (`Unlisted`), never read as fewer open jobs. */
export async function openJobs(call: (path: string) => Promise<Response>): Promise<ListedJob[]> {
  const open: ListedJob[] = [];
  const seen = new Set<string>();
  let before: string | undefined;

  for (;;) {
    const answer = await call(`/jobs?limit=${String(PAGE)}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`);

    if (answer.status === 404) throw new Unlisted('unavailable');
    const { jobs } = v.parse(v.object({ jobs: v.array(ListedJobSchema) }), await answer.json());

    for (const job of jobs) {
      if (seen.has(job.id)) throw new Unlisted('repeated');
      seen.add(job.id);

      if (job.phase !== 'done') open.push(job);
    }

    if (jobs.length < PAGE) return open;
    before = jobs.at(-1)?.id;
  }
}

/** Each of `jobs` in one line, oldest first: its id, label, phase and age in minutes at `now`. */
export function describeJobs(jobs: readonly ListedJob[], now: number): string[] {
  return jobs.toSorted((a, b) => (a.createdAt ?? now) - (b.createdAt ?? now)).map((job) => {
    const age = job.createdAt === undefined ? 'age unsaid' : `${String(Math.round((now - job.createdAt) / 60_000))} min old`;

    return `${job.id}${job.label === '' ? '' : ` ${job.label}`} (${job.phase}, ${age})`;
  });
}

/** What a drain asks of the deployed version: to admit no new job (answering how many are open, or null for a Worker
 *  too old to drain), to admit jobs again, and its open jobs. */
export interface Drainable {
  drain(signal?: AbortSignal): Promise<number | null>;
  admit(signal?: AbortSignal): Promise<void>;
  openJobs(signal?: AbortSignal): Promise<ListedJob[]>;
}

/** A drain that reached its bound: nothing is deployed, and the deployed version admits jobs again, or lets its drain
 *  lapse by itself where the admission went unanswered. */
export class DrainBound extends Error {
  override readonly name = 'DrainBound';
}

/** A drain's bound, how it tells of the drain (`held`: true once the deployed version admits no job, false once it
 *  admits jobs again or its drain is left to lapse) and of each wait, and its clock: `sleep` waits between asks,
 *  `expiry` settles once a span has passed (a Worker request still pending then is abandoned). */
export interface DrainOptions {
  readonly boundMs: number;
  readonly held: (held: boolean) => void;
  readonly say: (line: string) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly expiry: (ms: number) => Promise<void>;
  readonly pollMs: number;
}

/** The longest the admission and the last listing at a drain's bound are waited for. */
const CLEANUP_MS = 30_000;

/** `request`'s answer, or `late` where `expiry(ms)` settles first; either way its signal is then aborted, so a request
 *  given up on, and every retry of it, asks the Worker nothing more (a drain's ask retried past the bound would
 *  renew the drain after its admission). */
async function within<T, L>(request: (signal: AbortSignal) => Promise<T>, ms: number, expiry: (ms: number) => Promise<void>,
  late: L): Promise<T | L> {
  const stop = new AbortController();
  const asked = request(stop.signal);

  // The loser's end, an abort's rejection among them, is no one's to hear.
  asked.catch(() => undefined);

  try {
    return await Promise.race([asked, expiry(Math.max(0, ms)).then(() => late)]);
  } finally {
    stop.abort();
  }
}

/** The deployed version's open jobs in one line each (`describeJobs`), or why they could not be listed: a Worker that
 *  predates `GET /jobs`, or one that does not answer, is drained all the same. */
async function listed(deployed: Drainable, ms: number, { now, expiry }: Pick<DrainOptions, 'now' | 'expiry'>): Promise<string> {
  try {
    const jobs = await within((signal) => deployed.openJobs(signal), ms, expiry, null);

    if (jobs === null) return 'its open jobs did not list in time';

    return jobs.length === 0 ? 'no open job listed' : describeJobs(jobs, now()).join('; ');
  } catch (cause) {
    return `its open jobs could not be listed (${cause instanceof Error ? cause.message : String(cause)})`;
  }
}

/** Drains `deployed` within `boundMs`: it admits no new job, which `held` is told of at once, and this waits for its
 *  open jobs to finish, saying them, oldest first with their ages, and each wait through `say`. Every ask of the
 *  Worker is bounded by what is left of the drain. Where the jobs have not finished by the bound, or the Worker stops
 *  answering, the deployed version is asked to admit jobs again and this throws `DrainBound` naming each job still
 *  open, so a deploy never refuses every lane's work unbounded (2026-11-14: a drain refused submissions for over an
 *  hour, unannounced, waiting on two jobs open since 19:47Z). A Worker too old to drain is said to be, and its
 *  running jobs end with the deploy. */
export async function drainWithin(deployed: Drainable, options: DrainOptions): Promise<void> {
  const { boundMs, held, say, now, sleep, expiry, pollMs } = options;
  const deadline = now() + boundMs;
  const left = () => deadline - now();
  const expired = Symbol('expired');
  let jobs = await within((signal) => deployed.drain(signal), left(), expiry, expired);

  if (jobs === null) {
    say('the deployed Worker cannot stop taking jobs, so any job it runs now ends with this deploy');

    return;
  }

  held(true);

  if (jobs !== expired && jobs > 0) say(`waiting on ${String(jobs)} open job${jobs === 1 ? '' : 's'}: ${await listed(deployed, Math.min(left(), CLEANUP_MS), options)}`);

  // Each ask renews the drain, which lapses by itself if this process dies.
  while (jobs === expired || (jobs !== null && jobs > 0)) {
    if (jobs === expired || left() <= 0) {
      // An admission refused or unanswered is unconfirmed, never a reason to wait on it again: the drain is let go.
      const admitted = await within(async (signal) => await deployed.admit(signal).then(() => true, () => false), CLEANUP_MS, expiry, false);

      held(false);
      throw new DrainBound(`the drain reached its bound of ${String(Math.round(boundMs / 60_000))} min, so nothing was deployed and ${admitted ? 'the deployed version admits jobs again' : 'its admission went unanswered: the drain lapses by itself once this deploy stops asking'}; still open: ${await listed(deployed, CLEANUP_MS, options)}`);
    }

    say(`waiting for ${String(jobs)} open job${jobs === 1 ? '' : 's'} to finish; new jobs are refused until the deploy is done, at most ${String(Math.ceil(left() / 60_000))} min more`);
    await sleep(Math.min(pollMs, left()));
    jobs = left() <= 0 ? expired : await within((signal) => deployed.drain(signal), left(), expiry, expired);
  }
}
