import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import {
  seedSystemFertilizers,
  seedWagePeriods,
  seedAnnualConfig,
} from './services/cardamom-seed.service.js';

async function bootstrap() {
  await connectDb();

  const fertResult = await seedSystemFertilizers();
  console.log(
    `[seed] fertilizers: ${fertResult.upserted} new, ` +
      `${fertResult.modified} updated, ${fertResult.total} total`,
  );

  const cgaResult = await seedWagePeriods();
  console.log(
    `[seed] CGA circulars: ${cgaResult.upserted} new, ` +
      `${cgaResult.modified} updated, ${cgaResult.total} total`,
  );

  const acResult = await seedAnnualConfig();
  console.log(
    `[seed] annual config: ${acResult.upserted ? 'created' : 'exists'} for ${acResult.year}`,
  );

  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[server] listening on http://localhost:${env.port}`);
    console.log(`[server] env=${env.nodeEnv}`);
  });
}

bootstrap().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
