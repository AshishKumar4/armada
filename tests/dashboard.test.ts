import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboard } from '../src/dashboard';

describe('the dashboard a deploy builds', () => {
  test('holds every file its page loads, a script that writes no markup, and a policy that runs only its own script', async () => {
    const out = mkdtempSync(join(tmpdir(), 'armada-dashboard-'));

    try {
      await buildDashboard(out);
      const page = readFileSync(join(out, 'ui', 'index.html'), 'utf8');
      const script = readFileSync(join(out, 'ui', 'app.js'), 'utf8');
      const loaded = [...page.matchAll(/(?:src|href)="\/ui\/([^"]+)"/gu)].map((match) => [match[1], existsSync(join(out, 'ui', match[1] ?? ''))]);
      const policy = readFileSync(join(out, '_headers'), 'utf8');

      expect({
        loaded, written: script.length > 10_000, markup: /\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/u.test(script),
        policy: ["script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"].every((rule) => policy.includes(rule)),
      }).toEqual({ loaded: [['favicon.svg', true], ['app.css', true], ['app.js', true]], written: true, markup: false, policy: true });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
