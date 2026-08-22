import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`[team-site-api] listening on http://${HOST}:${PORT}`);
});
