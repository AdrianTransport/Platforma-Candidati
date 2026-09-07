import { connectLambda } from '@netlify/blobs';
import serverless from 'serverless-http';
import { createApp } from '../../app.js';
import { createEditorial } from '../../editorial.js';

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

export const handler = async (event, context) => {
  // Functia ruleaza in mod compatibil AWS Lambda (prin serverless-http). In acest
  // mod, Netlify Blobs nu primeste automat contextul cererii - trebuie legat
  // explicit, la FIECARE invocare, inainte de orice citire/scriere in Blobs.
  connectLambda(event);

  if (!handlerPromise) {
    // Păstrăm adaptorul existent; imaginile trebuie codate binar, nu ca text UTF-8.
    // Variabilele cu scope Functions sunt citite prin API-ul runtime Netlify.
    const editorial = createEditorial({ env: readEditorialEnv() });
    handlerPromise = createApp({ editorial }).then((app) => serverless(app, {
      binary: ['image/png', 'image/jpeg', 'image/webp'],
    }));
  }
  const serverlessHandler = await handlerPromise;
  return serverlessHandler(event, context);
};
