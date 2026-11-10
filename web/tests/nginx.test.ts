import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The image cannot be built or run on the developer machine (no Docker, no nginx), so these
// checks parse nginx.conf as text: a tiny parser for the directives the file uses, with
// `include` expanded in place. They pin the caching and security rules; CI builds the image.

const webRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(webRoot, '..');

interface Block {
  name: string;
  args: string;
  directives: { name: string; args: string }[];
  children: Block[];
}

const readConf = (path: string): string => {
  const text = readFileSync(path, 'utf8').replace(/#[^\n]*/g, '');
  return text.replace(/^\s*include\s+([^;]+);/gm, (_m, file: string) =>
    readConf(join(webRoot, file.trim().replace(/^\/etc\/nginx\//, ''))),
  );
};

const parse = (text: string): Block => {
  const root: Block = { name: 'root', args: '', directives: [], children: [] };
  const stack: Block[] = [root];
  for (const match of text.matchAll(/((?:"[^"]*"|[^;{}"])+)([;{])|\}/g)) {
    const top = stack.at(-1) as Block;
    if (match[0] === '}') {
      stack.pop();
      continue;
    }
    const words = (match[1] as string).trim().replace(/\s+/g, ' ');
    const space = words.indexOf(' ');
    const name = space === -1 ? words : words.slice(0, space);
    const args = space === -1 ? '' : words.slice(space + 1);
    if (match[2] === ';') {
      top.directives.push({ name, args });
    } else {
      const block: Block = { name, args, directives: [], children: [] };
      top.children.push(block);
      stack.push(block);
    }
  }
  return root;
};

const server = parse(readConf(join(webRoot, 'nginx.conf'))).children.find((b) => b.name === 'server');
const locations = (server?.children ?? []).filter((b) => b.name === 'location');
const location = (args: string): Block => {
  const found = locations.find((b) => b.args === args);
  if (!found) throw new Error(`location ${args} is missing`);
  return found;
};
// Every add_header of a location, grouped by lower-cased name. A header sent twice is a bug
// (the first value could be a wrong one), so callers assert exactly one value.
const headerValues = (block: Block): Map<string, string[]> => {
  const all = new Map<string, string[]>();
  for (const d of block.directives.filter((x) => x.name === 'add_header')) {
    const [key = '', ...rest] = d.args.split(' ');
    const value = rest.join(' ').replace(/ always$/, '').replace(/^"|"$/g, '');
    all.set(key.toLowerCase(), [...(all.get(key.toLowerCase()) ?? []), value]);
  }
  return all;
};
const headers = (block: Block): Map<string, string> =>
  new Map([...headerValues(block)].map(([key, values]) => [key, values.at(-1) as string]));
const alwaysFlag = (block: Block, header: string): boolean =>
  block.directives.some(
    (d) => d.name === 'add_header' && d.args.toLowerCase().startsWith(header) && / always$/.test(d.args),
  );

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

describe('nginx.conf', () => {
  it('is a server block on the unprivileged port 8080 serving the built dist', () => {
    expect(server).toBeDefined();
    expect(server?.directives).toContainEqual({ name: 'listen', args: '8080' });
    expect(server?.directives).toContainEqual({ name: 'root', args: '/usr/share/nginx/html' });
    expect(server?.directives).toContainEqual({ name: 'server_tokens', args: 'off' });
  });

  it('compresses text, including javascript served as text/javascript', () => {
    expect(server?.directives).toContainEqual({ name: 'gzip', args: 'on' });
    const types = server?.directives.find((d) => d.name === 'gzip_types')?.args.split(' ') ?? [];
    expect(types).toEqual(
      expect.arrayContaining(['text/css', 'text/javascript', 'application/javascript', 'application/json']),
    );
  });

  it('serves the manifest as application/manifest+json and answers /healthz with 200', () => {
    expect(location('= /manifest.webmanifest').directives).toContainEqual({
      name: 'default_type',
      args: 'application/manifest+json',
    });
    expect(location('= /healthz').directives).toContainEqual({ name: 'return', args: '200 "ok\\n"' });
  });

  it('listens on IPv4 only, so a host without IPv6 cannot stop nginx from starting', () => {
    expect(server?.directives.filter((d) => d.name === 'listen')).toEqual([{ name: 'listen', args: '8080' }]);
  });

  it('falls back to index.html for app routes', () => {
    const fallback = location('/').directives.find((d) => d.name === 'try_files');
    expect(fallback?.args).toBe('$uri /index.html');
  });

  it.each(['= /sw.js', '= /index.html', '= /manifest.webmanifest'])(
    'serves %s with Cache-Control: no-cache',
    (args) => {
      expect(headers(location(args)).get('cache-control')).toBe('no-cache');
    },
  );

  it('serves every other file revalidated, never immutable', () => {
    expect(headers(location('/')).get('cache-control')).toBe('no-cache');
  });

  it('serves hashed /assets/ as immutable for a year, and a missing asset is a 404', () => {
    const assets = location('^~ /assets/');
    expect(headers(assets).get('cache-control')).toBe('public, max-age=31536000, immutable');
    // without `always` the header is not added to the 404 of a missing file
    expect(alwaysFlag(assets, 'cache-control')).toBe(false);
    expect(assets.directives.find((d) => d.name === 'try_files')?.args).toBe('$uri =404');
  });

  it('never lets the SPA fallback swallow /v1', () => {
    const api = location('^~ /v1');
    expect(api.directives.some((d) => d.name === 'try_files')).toBe(false);
    expect(api.directives).toContainEqual({ name: 'return', args: '404' });
    expect(headers(api).get('cache-control')).toBe('no-store');
  });

  it('sends the security headers on every location (add_header does not inherit)', () => {
    expect(locations.length).toBeGreaterThanOrEqual(6);
    for (const block of locations) {
      const sent = headerValues(block);
      for (const [key, value] of Object.entries(securityHeaders)) {
        expect(sent.get(key), `${block.args}: ${key}`).toEqual([value]);
      }
      expect(sent.get('cache-control'), `${block.args}: cache-control`).toHaveLength(1);
    }
  });

  it('keeps the policy tight: same-origin connections and no framing', () => {
    const csp = securityHeaders['content-security-policy'];
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-|\*|https?:/);
  });

  it('has LF line endings and no addresses or secrets', () => {
    for (const file of ['nginx.conf', 'security-headers.conf', 'Dockerfile', '.dockerignore']) {
      const text = readFileSync(join(webRoot, file), 'utf8');
      expect(text, file).not.toContain('\r');
      // loopback in the healthcheck is the only address allowed
      expect(text.replaceAll('127.0.0.1', ''), file).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  });
});

describe('Dockerfile', () => {
  const dockerfile = readFileSync(join(webRoot, 'Dockerfile'), 'utf8');
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1] as string);

  it('builds with node 24 alpine and serves with a pinned nginx-unprivileged', () => {
    expect(froms).toHaveLength(2);
    expect(froms[0]).toMatch(/^node:24\.\d+\.\d+-alpine\d+\.\d+$/);
    expect(froms[1]).toMatch(/^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine\d+\.\d+$/);
    for (const from of froms) expect(from).not.toMatch(/latest|\$/);
  });

  it('runs npm ci and the build, then copies dist and the config into nginx', () => {
    // install scripts of dependencies never run inside the image build
    expect(dockerfile).toMatch(/npm ci --ignore-scripts/);
    expect(dockerfile).toMatch(/npm run build/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/dist \/usr\/share\/nginx\/html/);
    expect(dockerfile).toMatch(/COPY nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf/);
    expect(dockerfile).toMatch(/COPY security-headers\.conf \/etc\/nginx\/security-headers\.conf/);
  });

  it('probes the loopback IPv4 address, not localhost', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:8080\/healthz/);
  });

  it('keeps env files, coverage and local overrides out of the build context', () => {
    const ignored = readFileSync(join(webRoot, '.dockerignore'), 'utf8').split(/\r?\n/);
    expect(ignored).toEqual(expect.arrayContaining(['node_modules', 'dist', '.env*', 'coverage', '*.local']));
  });

  it('stays non-root, exposes 8080 and has a healthcheck', () => {
    expect(dockerfile).toMatch(/^USER\s+(nginx|101)\s*$/m);
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK\b/m);
  });
});

describe('deploy wiring', () => {
  const compose = readFileSync(join(repoRoot, 'deploy/compose/yawmi-api.api.yml'), 'utf8');

  it('adds a yawmi-web service on a pinned image with a priority-1 catch-all router', () => {
    expect(compose).toMatch(/^ {2}yawmi-web:/m);
    expect(compose).toMatch(/image: ghcr\.io\/nexgen94\/yawmi-web:\d+\.\d+\.\d+/);
    expect(compose).toContain('traefik.http.routers.yawmi-web.rule=Host(`${YAWMI_API_HOST}`)"');
    expect(compose).toContain('traefik.http.routers.yawmi-web.priority=1"');
    expect(compose).toContain('traefik.http.services.yawmi-web.loadbalancer.server.port=8080"');
  });

  it('keeps the compose file within the Docker Manager limit', () => {
    expect(compose.length).toBeLessThanOrEqual(8192);
  });

  it('has an image workflow that fires on web-v* tags and pushes yawmi-web', () => {
    const path = join(repoRoot, '.github/workflows/web-image.yml');
    expect(existsSync(path)).toBe(true);
    const workflow = readFileSync(path, 'utf8');
    expect(workflow).toContain('"web-v*"');
    expect(workflow).toContain('ghcr.io/nexgen94/yawmi-web');
    expect(workflow).toMatch(/docker build[\s\S]*\sweb\s*$/m);
    expect(workflow).toContain('gzip');
    expect(workflow).toContain('nosniff');
    expect(workflow).toContain('no-referrer');
  });
});
