import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongodbUri, {
    serverSelectionTimeoutMS: 10_000,
  });
  console.log(`[db] connected to MongoDB (${maskUri(env.mongodbUri)})`);

  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error', err);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected');
  });
}

function maskUri(uri) {
  return uri.replace(/\/\/([^:@]+):([^@]+)@/, '//$1:***@');
}
