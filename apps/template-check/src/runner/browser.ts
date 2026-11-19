import { chromium } from 'playwright-core';

/**
 * Chromium as the Pi runs it for templates: sites isolated, so each sandboxed template frame gets a
 * renderer process of its own (the headless shell does neither unless told).
 */
export const launchBrowser = () => chromium.launch({ args: ['--site-per-process'] });
