import serverless from 'serverless-http';
import { connectLambda } from '@netlify/blobs';
import { createApp } from '../../app.js';

let handlerPromise;

export const handler = async (event, context) => {
  connectLambda(event);

  if (!handlerPromise) {
    handlerPromise = createApp().then((app) => serverless(app));
  }
  const serverlessHandler = await handlerPromise;
  return serverlessHandler(event, context);
};
