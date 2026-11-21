// Harness entrypoint: starts the local Express application on an ephemeral port,
// registers with the evaluation harness via MAKEFUN_ENV_URL, polls until the trial completes,
// and gracefully shuts down.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envUrl) {
  process.stderr.write('[entry] Error: MAKEFUN_ENV_URL environment variable is required\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function getBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(attempt, 8));
}

async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`Registration failed with status ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Registration failed with status ')) {
        throw err;
      }
    }
    await delay(getBackoff(attempt));
  }
}

async function waitForCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const data = (await response.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // Ignore network errors or timeouts during polling and retry.
    }
    await delay(getBackoff(attempt));
  }
}

async function start(): Promise<void> {
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });

  const address = app.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind server to an ephemeral TCP port');
  }

  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await registerPort(address.port);
  process.stdout.write('[entry] registered successfully; waiting for trial completion\n');

  await waitForCompletion();
  app.close();
  process.stdout.write('[entry] trial finished; shutting down\n');
}

try {
  await start();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
