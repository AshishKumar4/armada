/**
 * `armada runs`: the run records' bounds applied now (`prune`), and a record kept from every prune or let go again
 * (`hold`, `release`); and the bounds the connection file in use sets (`retentionOf`), which `armada run` applies
 * after each run. The records and their bounds are `runs.ts`'s; this is the command over them.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as v from 'valibot';
import { boundsOf, describeRemoved, describeSummary, holdRun, pruneRuns, recordName, releaseRun, RetentionSchema, RUNS, type Retention } from './runs';
import { connectionAt } from './sdk';

const SettingsSchema = v.looseObject({ retention: v.optional(RetentionSchema, {}) });

/** The bounds on the run records that the connection file in use sets (`retention`: `days` and `gb`); none where there is
 *  no such file, as when ARMADA_URL and ARMADA_TOKEN stand in for one. */
export function retentionOf(): Retention {
  const { file } = connectionAt(process.cwd());

  if (!existsSync(file)) return {};
  const settings = v.safeParse(SettingsSchema, JSON.parse(readFileSync(file, 'utf8')));

  if (!settings.success) throw new Error(`${file}: ${v.summarize(settings.issues)}`);

  return settings.output.retention;
}

/** The options `armada runs` was given, as the CLI parsed them. */
export interface RunsOptions {
  readonly days: number | undefined;
  readonly gb: number | undefined;
  readonly dry: boolean;
}

/** `runs prune` removes the run records past the bounds, `runs hold <name>` keeps one from every prune, and `runs release
 *  <name>` lets it go. */
export async function runsCommand(action: string | undefined, name: string | undefined, { days, gb, dry }: RunsOptions): Promise<number> {
  if (action === 'prune') {
    if (name !== undefined) throw new Error(`runs prune takes no record name, not ${name}`);
    const pruned = await pruneRuns(boundsOf(retentionOf(), { days, gb }), dry);

    for (const line of describeRemoved(pruned, dry)) console.log(line);
    console.log(describeSummary(pruned, dry));

    return 0;
  }

  if ((action !== 'hold' && action !== 'release') || name === undefined) throw new Error('runs takes prune, hold <name> or release <name>, as in: armada runs hold dew-20261108065807-be40ef9e');

  if (days !== undefined || gb !== undefined || dry) throw new Error(`--days, --gb and --dry-run are runs prune's, not runs ${action}'s`);
  const record = recordName(name);

  if (action === 'release') {
    console.log(await releaseRun(name) ? `released ${record}` : `${record} was not held`);

    return 0;
  }

  const { added, exists } = await holdRun(name);

  console.log(added ? `holding ${record}` : `${record} is already held`);

  if (!exists) console.error(`armada: no run record named ${record} is under ${RUNS} now; the hold keeps one that comes by that name`);

  return 0;
}
