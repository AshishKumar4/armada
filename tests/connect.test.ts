// A project names the armada deployment its CI runs on in its `.armada.json`, so a run from its checkout reaches that
// deployment with no ARMADA_CONNECTION exported by every hook and script that calls armada; a connection named to the
// run still comes first, and a project that names none reaches the machine's default, as before.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SDK = join(import.meta.dir, '..', 'src', 'sdk.ts');

/** The fields of a project's `.armada.json` these cases set. */
interface ProjectFile {
  readonly name: string;
  readonly deployment?: string;
}

/** A machine whose home holds the connections `deployed` names, and a project under it whose `.armada.json` is `project`. */
function machine(deployed: readonly string[], project: ProjectFile) {
  const home = mkdtempSync(join(tmpdir(), 'armada-connect-'));
  const config = join(home, '.config', 'armada');
  const checkout = join(home, 'work', 'kinu');

  mkdirSync(config, { recursive: true });
  mkdirSync(join(checkout, 'packages', 'cli'), { recursive: true });

  for (const name of deployed) {
    writeFileSync(join(config, name === 'armada' ? 'connection.json' : `${name}.json`), JSON.stringify({ url: `https://${name}.example.invalid`, token: 't', account: 'a' }));
  }

  writeFileSync(join(checkout, '.armada.json'), JSON.stringify(project));

  return { home, checkout };
}

/** What `connect()` reaches from `cwd`, run as a fresh process with `home` as its home: the URL, or the refusal. */
function connectedFrom(cwd: string, home: string, extra: Record<string, string> = {}): string {
  const env = { PATH: process.env['PATH'] ?? '', HOME: home, ...extra };
  const run = Bun.spawnSync([process.execPath, '-e', `const { connect } = await import(${JSON.stringify(SDK)}); try { console.log(connect().connection.url); } catch (error) { console.log(String(error)); }`], { cwd, env, stdout: 'pipe', stderr: 'pipe' });

  return run.stdout.toString().trim();
}

test("a run from a project's checkout, a folder below its root included, reaches the deployment its .armada.json names", () => {
  const { home, checkout } = machine(['armada', 'armada-kinu'], { name: 'kinu', deployment: 'armada-kinu' });

  expect([connectedFrom(checkout, home), connectedFrom(join(checkout, 'packages', 'cli'), home)])
    .toEqual(['https://armada-kinu.example.invalid', 'https://armada-kinu.example.invalid']);
});

test("a project that names no deployment reaches the machine's default", () => {
  const { home, checkout } = machine(['armada', 'armada-kinu'], { name: 'kinu' });

  expect(connectedFrom(checkout, home)).toBe('https://armada.example.invalid');
});

test('a connection named to the run comes before the one the project names', () => {
  const { home, checkout } = machine(['armada', 'armada-kinu', 'armada-other'], { name: 'kinu', deployment: 'armada-kinu' });

  expect(connectedFrom(checkout, home, { ARMADA_CONNECTION: join(home, '.config', 'armada', 'armada-other.json') })).toBe('https://armada-other.example.invalid');
});

test('a deployment the project names and this machine never deployed is refused by name, with the command that makes it', () => {
  const { home, checkout } = machine(['armada'], { name: 'kinu', deployment: 'armada-kinu' });

  expect(connectedFrom(checkout, home)).toContain('names the deployment armada-kinu, and this machine has no connection for it');
  expect(connectedFrom(checkout, home)).toContain('armada deploy --name=armada-kinu');
});
