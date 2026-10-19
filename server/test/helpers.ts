import { createApp, type App } from '../src/app.js';
import type { AnswerModel } from '../src/ask.js';
import { createAuth, migrateAuth } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { parseLabels } from '../src/labels.js';
import { FakeMailer } from '../src/mailer.js';
import type { WikiFetcher } from '../src/wiki.js';

export const ORIGIN = 'https://birdbrain-test.vercel.app';
export const ADMIN = 'sabih@example.com';

export const LABELS = parseLabels(['Turdus merula_Eurasian Blackbird', 'Parus major_Great Tit', 'Dog_Dog', 'Haemorhous mexicanus_House Finch']);

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    BETTER_AUTH_URL: 'https://api.test.local',
    ALLOWED_ORIGINS: ORIGIN,
    ADMIN_EMAIL: ADMIN,
    MAIL_TRANSPORT: 'console',
    DATABASE_PATH: ':memory:',
    ...overrides,
  });
}

export interface TestApp {
  app: App;
  mailer: FakeMailer;
  config: Config;
  modelCalls: Array<{ systemInstruction: string; prompt: string }>;
}

export async function buildTestApp(opts: { wiki?: WikiFetcher; model?: AnswerModel | null; env?: Partial<NodeJS.ProcessEnv>; limits?: Parameters<typeof createApp>[0]['limits'] } = {}): Promise<TestApp> {
  const config = testConfig(opts.env);
  const db = openDatabase(':memory:');
  await migrateAuth(db, config);
  const auth = createAuth(db, config);
  const mailer = new FakeMailer();
  const modelCalls: TestApp['modelCalls'] = [];
  const model: AnswerModel | null =
    opts.model === null
      ? null
      : (opts.model ??
        (async (input) => {
          modelCalls.push(input);
          return 'A plain answer from the source text.';
        }));
  const wiki: WikiFetcher = opts.wiki ?? (async (sci) => ({ title: sci, extract: `${sci} is a bird. It eats seeds.`, url: `https://en.wikipedia.org/wiki/${sci.replace(' ', '_')}` }));
  const app = createApp({ config, db, auth, mailer, labels: LABELS, wiki, model, limits: opts.limits });
  return { app, mailer, config, modelCalls };
}

export async function post(app: App, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
}

export async function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'GET', headers: { origin: ORIGIN, ...headers } });
}

export function codeFrom(mailer: FakeMailer, to: string): string {
  const mail = mailer.last(to);
  if (!mail) throw new Error(`no mail sent to ${to}`);
  const m = mail.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error('no code in mail');
  return m[1];
}

/** Sign up and complete the code step; returns a bearer token. */
export async function signUpAndLogin(t: TestApp, email: string, password = 'correct horse battery staple'): Promise<string> {
  const su = await post(t.app, '/v1/auth/signup', { email, password });
  if (su.status !== 200) throw new Error(`signup ${su.status}`);
  const li = await post(t.app, '/v1/auth/login', { email, password });
  if (li.status !== 200) throw new Error(`login ${li.status}`);
  const { challenge } = (await li.json()) as { challenge: string };
  const ve = await post(t.app, '/v1/auth/verify', { challenge, code: codeFrom(t.mailer, email) });
  if (ve.status !== 200) throw new Error(`verify ${ve.status}`);
  return ((await ve.json()) as { token: string }).token;
}
