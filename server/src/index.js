import './load-env.js';
import { createApp } from './app.js';
import { validateRuntimeConfig } from './runtime-config.js';

const { port } = validateRuntimeConfig();
const app = createApp();

app.listen(port, () => {
  console.log(`Employee Service API listening on port ${port}`);
});
