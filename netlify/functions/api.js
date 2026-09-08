import { connectLambda } from '@netlify/blobs';
import serverless from 'serverless-http';
import { createApp } from '../../app.js';
import { createEditorial, createEditorialStore } from '../../editorial.js';
import { migrateAuth } from '../../migrate-auth.js';

let handlerPromise;

const EDITORIAL_ENV_KEYS = [
  'PLATFORM_OPENAI_API_KEY',
  'AI_GENERATION_ENABLED',
  'AI_TEXT_DAILY_LIMIT',
  'AI_IMAGE_DAILY_LIMIT',
];

export function readEditorialEnv(getValue = (key) => (
  typeof Netlify === 'undefined' ? process.env[key] : Netlify.env.get(key)
)) {
  return Object.fromEntries(EDITORIAL_ENV_KEYS.flatMap((key) => {
    const value = getValue(key);
    return typeof value === 'string' ? [[key, value]] : [];
  }));
}

function runtimeValue(key) {
  const value = typeof Netlify === 'undefined' ? process.env[key] : Netlify.env.get(key);
  return typeof value === 'string' && value ? value : undefined;
}

export function readBlobsCredentials(event) {
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    const siteID = event.headers?.['x-nf-site-id'];
    return typeof siteID === 'string' && typeof data.token === 'string'
      ? { siteID, token: data.token }
      : undefined;
  } catch { return undefined; }
}

export const handler = async (event, context) => {
  // Functia ruleaza in mod compatibil AWS Lambda (prin serverless-http). In acest
  // mod, Netlify Blobs nu primeste automat contextul cererii - trebuie legat
  // explicit, la FIECARE invocare, inainte de orice citire/scriere in Blobs.
  connectLambda(event);

  const value = key => typeof Netlify === 'undefined' ? process.env[key] : Netlify.env.get(key);

  const supabaseSecret = value('SUPABASE_SECRET_KEY');
  Object.assign(process.env, {
    SUPABASE_SECRET_KEY: supabaseSecret,
    DATA_BACKEND: value('DATA_BACKEND') || (supabaseSecret ? 'supabase' : undefined),
  });

  if (event.path?.endsWith('/internal/migrate-supabase-auth')) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    return migrateAuth({
      authorization: event.headers?.authorization || event.headers?.Authorization,
      token: value('AUTH_MIGRATION_TOKEN'),
      key: supabaseSecret,
    });
  }

  if (!handlerPromise) {
    // Păstrăm adaptorul existent; imaginile trebuie codate binar, nu ca text UTF-8.
    // Variabilele cu scope Functions sunt citite prin API-ul runtime Netlify.
    // Forțăm explicit adaptorul Blobs: process.env nu reflectă întotdeauna toate
    // valorile runtime expuse prin Netlify.env în această funcție compatibilă Lambda.
    const store = createEditorialStore({
      serverless: true,
      context: runtimeValue('CONTEXT'),
      region: runtimeValue('AWS_REGION'),
      credentials: readBlobsCredentials(event),
    });
    const editorial = createEditorial({ store, env: readEditorialEnv() });
    handlerPromise = createApp({ editorial }).then((app) => serverless(app, {
      binary: ['image/png', 'image/jpeg', 'image/webp'],
    }));
  }
  const serverlessHandler = await handlerPromise;
  return serverlessHandler(event, context);
};
