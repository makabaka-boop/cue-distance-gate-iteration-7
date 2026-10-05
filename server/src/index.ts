import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({ logger: true });

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
