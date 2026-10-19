import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createAskCostStore } from './ask-cost.js';
import { createGeminiModel } from './ask.js';
import { createAuth, migrateAuth } from './auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { loadLabels } from './labels.js';
import { createConsoleMailer, createSmtpMailer, withSendTimeout } from './mailer.js';
import { fetchWikipediaSummary } from './wiki.js';
import { createArticleCache, fetchWikipediaArticle } from './wiki-article.js';

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  await migrateAuth(db, config);
  const auth = createAuth(db, config);
  const labels = loadLabels(config.LABELS_PATH);
  const mailer = withSendTimeout(config.MAIL_TRANSPORT === 'smtp' ? createSmtpMailer(config.SMTP_USER!, config.SMTP_APP_PASSWORD!, config.MAIL_FROM ?? `Sabih's Birdbrain <${config.SMTP_USER}>`) : createConsoleMailer());
  const costs = createAskCostStore(db);
  const model = config.GEMINI_API_KEY ? createGeminiModel(config.GEMINI_API_KEY, config.GEMINI_MODEL, undefined, undefined, costs) : null;
  if (!model) console.warn('[startup] GEMINI_API_KEY not set: /v1/ask will answer 502');
  const article = createArticleCache(db).wrap(fetchWikipediaArticle);
  const app = createApp({ config, db, auth, mailer, labels, wiki: fetchWikipediaSummary, article, model, costs });

  const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    console.log(`[startup] birdbrain-api listening on ${info.address}:${info.port} (${labels.byScientific.size} species, mail=${config.MAIL_TRANSPORT})`);
  });

  const shutdown = () => {
    console.log('[shutdown] closing');
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`[startup] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
