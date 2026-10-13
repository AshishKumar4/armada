/**
 * The dashboard (worker/dashboard) from this machine's side: built for a browser into the directory `armada deploy`
 * hands the Worker as its static assets, which serve it under /ui/; and `armada dashboard`, which opens a deployment's
 * signed in, or serves one from here for a deployment whose Worker has none.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { DEPLOYMENT_HEADER, jsonOf, PROTOCOL, PROTOCOL_HEADER } from './protocol';
import { CONFIG_DIR, ConnectionSchema, type Armada, type Connection } from './sdk';

const SOURCE = join(import.meta.dir, '..', 'worker', 'dashboard');

/** What the page loads beside its script, copied as written. */
const STATIC = ['index.html', 'app.css', 'favicon.svg'];

/** The dashboard into `out`: its files under `ui/`, and the headers they are served with at the root, where a Worker's
 *  static assets read them. */
export async function buildDashboard(out: string): Promise<void> {
  const ui = join(out, 'ui');

  rmSync(out, { recursive: true, force: true });
  mkdirSync(ui, { recursive: true });
  const built = await Bun.build({ entrypoints: [join(SOURCE, 'app.ts')], outdir: ui, naming: 'app.js', target: 'browser', format: 'esm', minify: true });

  if (!built.success) throw new Error(`building the dashboard failed:\n${built.logs.map(String).join('\n')}`);

  for (const file of STATIC) copyFileSync(join(SOURCE, file), join(ui, file));
  copyFileSync(join(SOURCE, '_headers'), join(out, '_headers'));
}

/** The deployment's dashboard, signed in: the bearer rides in the fragment, which a browser sends to no server. */
export const dashboardUrl = (armada: Armada): string => `${armada.connection.url.replace(/\/$/u, '')}/ui/#token=${armada.connection.token}`;

/** How long a deployment has to answer before the dashboard leaves it out. */
const ASKED_MS = 5000;

/** `armada`'s dashboard, signed in to every deployment this machine has a connection to that answers, which it reads
 *  beside its own: their URLs and bearers ride in the fragment. A connection left by a deployment since destroyed, or
 *  one file naming the same deployment as another, adds nothing. */
export async function everyDashboardUrl(armada: Armada): Promise<string> {
  const files = readdirSync(CONFIG_DIR).filter((file) => file.endsWith('.json') && !file.endsWith('.destroy.json'));

  const kept = files.flatMap((file) => {
    const parsed = v.safeParse(ConnectionSchema, jsonOf(readFileSync(join(CONFIG_DIR, file), 'utf8')));

    return parsed.success ? [parsed.output] : [];
  });

  const urls = new Map([armada.connection, ...kept].map((each) => [each.url.replace(/\/$/u, ''), each]));

  const answers = await Promise.allSettled([...urls].map(async ([url, { token }]: [string, Connection]) => {
    const answer = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL) }, signal: AbortSignal.timeout(ASKED_MS) });

    return answer.ok ? [{ name: new URL(url).hostname.split('.')[0] ?? url, url, token }] : [];
  }));

  const deployments = answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value : []);

  return `${armada.connection.url.replace(/\/$/u, '')}/ui/#deployments=${Buffer.from(JSON.stringify(deployments)).toString('base64url')}`;
}

/** Opens `url` in this machine's browser; false when there is none to open it with. */
export function openInBrowser(url: string): boolean {
  const opener = OPENERS[process.platform] ?? ['xdg-open'];
  const [program = ''] = opener;

  return Bun.which(program) !== null && Bun.spawnSync([...opener, url], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
}

/** What opens a URL in the browser, by platform; the rest have xdg-open. */
const OPENERS: Partial<Record<NodeJS.Platform, readonly string[]>> = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] };

/** Serves the dashboard on this machine's loopback `port`, built again for each page load so an edit shows on reload,
 *  and passes every other request to the deployment under its bearer: the browser then holds no token, and nothing
 *  beyond this machine reaches the bearer. Runs until interrupted. */
export async function serveDashboard(armada: Armada, port: number): Promise<never> {
  const out = mkdtempSync(join(tmpdir(), 'armada-dashboard-'));
  const origin = armada.connection.url.replace(/\/$/u, '');

  process.once('SIGINT', () => {
    rmSync(out, { recursive: true, force: true });
    process.exit(0);
  });

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === '/' || url.pathname === '/ui') return Response.redirect('/ui/', 302);

      if (url.pathname.startsWith('/ui/')) {
        if (url.pathname === '/ui/') await buildDashboard(out);
        const file = Bun.file(join(out, url.pathname === '/ui/' ? 'ui/index.html' : url.pathname.slice(1)));

        return await file.exists() ? new Response(file) : new Response('not found', { status: 404 });
      }

      // Read only: the bearer goes with a dashboard's GETs, never a page's POST to /drain or /cancel.
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('the dashboard only reads', { status: 405 });
      const headers = new Headers(request.headers);

      headers.set('authorization', `Bearer ${armada.connection.token}`);
      headers.delete('host');
      const answer = await fetch(origin + url.pathname + url.search, { method: request.method, headers });
      // fetch has already inflated a gzipped log, so the length and encoding it came with no longer hold.
      const passed = new Headers(answer.headers);

      passed.delete('content-encoding');
      passed.delete('content-length');
      passed.set(DEPLOYMENT_HEADER, new URL(origin).hostname);

      return new Response(answer.body, { status: answer.status, headers: passed });
    },
  });

  console.log(`the dashboard of ${origin} is at http://localhost:${String(server.port)}/ui/; Ctrl-C stops it`);

  return await new Promise<never>(() => undefined);
}
