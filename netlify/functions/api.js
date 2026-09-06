import { connectLambda } from '@netlify/blobs';
import serverless from 'serverless-http';
import { createApp } from '../../app.js';

let handlerPromise;

export const handler = async (event, context) => {
  // Functia ruleaza in mod compatibil AWS Lambda (prin serverless-http). In acest
  // mod, Netlify Blobs nu primeste automat contextul cererii - trebuie legat
  // explicit, la FIECARE invocare, inainte de orice citire/scriere in Blobs.
  connectLambda(event);

  if (!handlerPromise) {
    handlerPromise = createApp().then((app) => serverless(app));
  }
  const serverlessHandler = await handlerPromise;
  return serverlessHandler(event, context);
};
