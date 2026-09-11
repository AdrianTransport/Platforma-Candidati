import 'dotenv/config';
import { createApp } from './app.js';

const portArgument = process.argv.indexOf('--port');
const PORT = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Portul serverului local trebuie să fie un număr între 1 și 65535.');
}

createApp().then((app) => {
  app.listen(PORT, () => {
    console.log(`Platforma ruleaza pe http://localhost:${PORT}`);
  });
});
