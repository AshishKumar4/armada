// bun bench.ts <n> [parallel | serial | cached]: n videos to 720p on n containers, in one container, or twice through
// the cache. Run it from this folder, so the first run pushes its tasks.
import { encode, encodeAll, encodeCached } from './armada/video';

const count = Number(process.argv[2] ?? '100');
const mode = process.argv[3] ?? 'parallel';
const items = Array.from({ length: count }, (_, index) => index + 1);
const timed = async <T>(run: () => Promise<T>) => {
  const started = Date.now();
  const value = await run();

  return { seconds: (Date.now() - started) / 1000, value };
};
const s = (seconds: number) => `${seconds.toFixed(1)} s`;
const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

if (mode === 'serial') {
  const { seconds } = await timed(async () => await encodeAll.run(count));

  console.log(`${String(count)} videos one after another in one container: ${s(seconds)}, ${s(seconds / count)} a video`);
} else if (mode === 'cached') {
  // Items no earlier run asked for, so the first pass computes every answer.
  const fresh = items.map((item) => item + Date.now() % 1_000_000 * 1000);

  for (const pass of ['first', 'second']) {
    const job = encodeCached.stream(fresh, { pool: count });
    const { seconds, value } = await timed(async () => await job.settled());
    const containers = (await job.status()).vessels.length;

    console.log(`${pass} pass: ${String(value.filter((result) => result.meta.cached).length)} of ${String(count)} cached, ${s(seconds)} on ${String(containers)} containers`);
  }
} else {
  const job = encode.stream(items, { pool: count });
  const { seconds, value } = await timed(async () => await job.settled());
  const status = await job.status();
  const summary = await job.summary();
  const encodes = value.filter((result) => result.ok).map((result) => result.meta.seconds);
  const longest = Math.max(0, ...encodes);
  const boots = summary.bootMs.map((ms) => ms / 1000);
  const busy = status.vessels.reduce((sum, vessel) => sum + vessel.busyMs, 0) / 1000;

  console.log(`${String(encodes.length)} of ${String(count)} videos on ${String(status.vessels.length)} containers: ${s(seconds)} from sending them to the last download`);
  console.log(`  each encode: median ${s(median(encodes))}, longest ${s(longest)}, ${s(encodes.reduce((sum, each) => sum + each, 0))} in all`);
  console.log(`  containers answered ${s(boots[0] ?? 0)} to ${s(boots.at(-1) ?? 0)} after the job asked for them (median ${s(median(boots))})`);
  // One video a container: no run can end before its longest encode, which is the bound with instant containers.
  console.log(`  tasks ran for ${s(summary.mapMs / 1000)}; the bound is the longest encode, ${s(longest)}, so this run took ${(seconds / longest).toFixed(1)}x the bound`);
  console.log(`  containers spent ${(100 * busy / (status.vessels.length * summary.mapMs / 1000)).toFixed(0)}% of the run encoding`);
}
