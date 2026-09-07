import path from 'node:path';
import { createBlobCommentStore, createLocalCommentStore } from './comment-store.js';

// Sesizările, acceptările și evenimentele de audit au fiecare o cheie unică.
// Astfel, două cereri simultane nu rescriu același document din Netlify Blobs.
export function createComplianceStore() {
  const serverless = process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!serverless) return createLocalCommentStore(path.join(process.cwd(), 'data', 'compliance'));

  let adapter;
  async function ready() {
    if (!adapter) {
      const { getStore, getDeployStore } = await import('@netlify/blobs');
      const options = { name: 'campanie-compliance' };
      const preview = process.env.CONTEXT && process.env.CONTEXT !== 'production';
      const deployOptions = process.env.AWS_REGION ? { ...options, region: process.env.AWS_REGION } : options;
      adapter = createBlobCommentStore(preview ? getDeployStore(deployOptions) : getStore(options));
    }
    return adapter;
  }

  return Object.fromEntries(['get', 'set', 'keys', 'delete'].map(method =>
    [method, async (...args) => (await ready())[method](...args)]));
}
