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

if (mode === 'serial') {
  const { seconds } = await timed(async () => await encodeAll.run(count));

  console.log(`${String(count)} videos one after another in one container: ${seconds.toFixed(1)} s`);
} else if (mode === 'cached') {
  // Items no earlier run asked for, so the first pass computes every answer.
  const fresh = items.map((item) => item + Date.now() % 1_000_000 * 1000);

  for (const pass of ['first', 'second']) {
    const job = encodeCached.stream(fresh, { pool: count });
    const { seconds, value } = await timed(async () => await job.settled());
    const containers = (await job.status()).vessels.length;

    console.log(`${pass} pass: ${String(value.filter((result) => result.meta.cached).length)} of ${String(count)} cached, ${seconds.toFixed(1)} s on ${String(containers)} containers`);
  }
} else {
  const job = encode.stream(items, { pool: count });
  const { seconds, value } = await timed(async () => await job.settled());

  console.log(`${String(value.filter((result) => result.ok).length)} videos on ${String((await job.status()).vessels.length)} containers: ${seconds.toFixed(1)} s`);
}
