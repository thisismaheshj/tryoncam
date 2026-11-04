/**
 * Local entry point. Serverless imports `app` from server.js instead and never
 * calls start(), because the platform owns the listener there.
 */
import { refreshSettings } from './settings.js';
import { start } from './server.js';

await refreshSettings();
start();
