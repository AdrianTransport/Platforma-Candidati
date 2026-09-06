import 'dotenv/config';
import { createApp } from './app.js';

const PORT = process.env.PORT || 3000;

createApp().then((app) => {
  app.listen(PORT, () => {
    console.log(`Platforma ruleaza pe http://localhost:${PORT}`);
  });
});
