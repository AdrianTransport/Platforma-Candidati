import serverless from 'serverless-http';
import { createApp } from '../../app.js';

let handlerPromise;

export const handler = async (event, context) => {
  if (!handlerPromise) {
    handlerPromise = createApp().then((app) => serverless(app));
  }
  const serverlessHandler = await handlerPromise;
  return serverlessHandler(event, context);
};
