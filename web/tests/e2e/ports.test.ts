import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, resolvePorts } from '../../e2e/ports';

// Two agents (or two terminals) on one machine must not collide on the ports of the end-to-end
// suite: the API and the preview ports come from the environment, 8000 and 4173 by default.

const web = resolve(import.meta.dirname, '..', '..');

describe('the ports of the end-to-end suite', () => {
  it('default to 8000 for the API and 4173 for the preview', () => {
    expect(DEFAULT_API_PORT).toBe(8000);
    expect(DEFAULT_WEB_PORT).toBe(4173);
    expect(resolvePorts({})).toEqual({ api: 8000, web: 4173 });
  });

  it('read YAWMI_API_PORT and YAWMI_WEB_PORT', () => {
    expect(resolvePorts({ YAWMI_API_PORT: '8101', YAWMI_WEB_PORT: '4201' })).toEqual({ api: 8101, web: 4201 });
  });

  it('ignore an empty value and refuse a value that is not a port', () => {
    expect(resolvePorts({ YAWMI_API_PORT: '', YAWMI_WEB_PORT: '  ' })).toEqual({ api: 8000, web: 4173 });
    for (const bad of ['abc', '80', '70000', '8000.5', '-1', '8000; rm']) {
      expect(() => resolvePorts({ YAWMI_API_PORT: bad }), bad).toThrow(/YAWMI_API_PORT/);
      expect(() => resolvePorts({ YAWMI_WEB_PORT: bad }), bad).toThrow(/YAWMI_WEB_PORT/);
    }
  });

  it('refuse the same port for both', () => {
    expect(() => resolvePorts({ YAWMI_API_PORT: '9000', YAWMI_WEB_PORT: '9000' })).toThrow(/same/);
  });

  it('are the only place the numbers 8000 and 4173 are written (config, fixtures and proxy read them)', () => {
    for (const path of ['playwright.config.ts', 'e2e/fixtures.ts', 'vite.config.ts']) {
      const code = readFileSync(join(web, path), 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, path).not.toMatch(/\b(?:8000|4173)\b/);
    }
  });
});
