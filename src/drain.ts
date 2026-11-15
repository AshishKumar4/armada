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

/** Every job of a deployment that is not done, each page of `GET /jobs` read through `call` (a path to its answer);
 *  a listing it cannot complete is refused, never read as fewer open jobs. */
export async function openJobs(call: (path: string) => Promise<Response>): Promise<ListedJob[]> {
  const open: ListedJob[] = [];
  const seen = new Set<string>();
  let before: string | undefined;

  for (;;) {
    const answer = await call(`/jobs?limit=${String(PAGE)}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`);

    if (answer.status === 404) throw new Error('GET /jobs is unavailable, so the open jobs cannot be listed');
    const { jobs } = v.parse(v.object({ jobs: v.array(ListedJobSchema) }), await answer.json());

    for (const job of jobs) {
      if (seen.has(job.id)) throw new Error('GET /jobs repeated an id while paging, so the open jobs cannot be listed');
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
  drain(): Promise<number | null>;
  admit(): Promise<void>;
  openJobs(): Promise<ListedJob[]>;
}

/** A drain that reached its bound, its deployed version admitting jobs again. */
export class DrainBound extends Error {
  override readonly name = 'DrainBound';
}

/** A drain's bound, how it tells of itself and of each wait, and its clock. */
export interface DrainOptions {
  readonly boundMs: number;
  readonly drained: () => void;
  readonly say: (line: string) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}

/** Drains `deployed` within `boundMs`: it admits no new job, which `drained` is told of at once, and this waits for
 *  its open jobs to finish, asking each `pollMs` and saying each wait through `say`. Where they have not finished by the bound, the deployed
 *  version admits jobs again and this throws `DrainBound` naming each job still open, so a deploy never refuses
 *  every lane's work unbounded (2026-11-14: a drain refused submissions for over an hour, unannounced, waiting on two
 *  jobs open since 19:47Z). A Worker too old to drain is said to be, and its running jobs end with the deploy. */
export async function drainWithin(deployed: Drainable, { boundMs, drained, say, now, sleep, pollMs }: DrainOptions): Promise<void> {
  let jobs = await deployed.drain();

  if (jobs === null) {
    say('the deployed Worker cannot stop taking jobs, so any job it runs now ends with this deploy');

    return;
  }

  drained();
  const started = now();

  // Each ask renews the drain, which lapses by itself if this process dies.
  while (jobs !== null && jobs > 0) {
    if (now() - started >= boundMs) {
      await deployed.admit();
      const left = describeJobs(await deployed.openJobs(), now());

      throw new DrainBound(`the drain reached its bound of ${String(Math.round(boundMs / 60_000))} min with ${String(jobs)} open job${jobs === 1 ? '' : 's'}, so nothing was deployed and the deployed version admits jobs again; still open: ${left.join('; ')}`);
    }

    say(`waiting for ${String(jobs)} open job${jobs === 1 ? '' : 's'} to finish; new jobs are refused until the deploy is done, at most ${String(Math.round((boundMs - (now() - started)) / 60_000))} min more`);
    await sleep(pollMs);
    jobs = await deployed.drain();
  }
}
