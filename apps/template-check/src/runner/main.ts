// The container's entry point (Dockerfile). Settings come from the Durable Object's `start()`.
import { startRunner } from './server';

await startRunner({
  port: Number(process.env.PORT ?? 8080),
  image: process.env.RUNNER_IMAGE ?? 'local',
  probeUrl: process.env.NETWORK_PROBE_URL ?? 'https://www.cloudflare.com/cdn-cgi/trace',
});
console.log('template-check runner listening');
