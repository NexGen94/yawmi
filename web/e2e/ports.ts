/** The ports of the end-to-end suite, from the environment so that two runs on one machine (two
 *  agents, two terminals) do not collide: `YAWMI_API_PORT` for the test API and `YAWMI_WEB_PORT`
 *  for `vite preview`. The defaults are the numbers the CI workflow and the documentation use. */
export const DEFAULT_API_PORT = 8000;
export const DEFAULT_WEB_PORT = 4173;

export interface Ports {
  api: number;
  web: number;
}

function port(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a port between 1024 and 65535, not "${raw}"`);
  }
  return value;
}

export function resolvePorts(env: Record<string, string | undefined>): Ports {
  const api = port(env, 'YAWMI_API_PORT', DEFAULT_API_PORT);
  const web = port(env, 'YAWMI_WEB_PORT', DEFAULT_WEB_PORT);
  if (api === web) throw new Error('YAWMI_API_PORT and YAWMI_WEB_PORT are the same port');
  return { api, web };
}

export const PORTS: Ports = resolvePorts(process.env);
