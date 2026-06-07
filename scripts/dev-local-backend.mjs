// Runs the Voyager Worker locally for UI development.
//
//   npm run dev:backend
//
// Applies D1 migrations to a persistent local state dir (so data survives
// restarts), then starts `wrangler dev` on :8787 with a BOOTSTRAP_TOKEN so the
// seed script can bootstrap the first platform owner. Leave this running and
// seed in another terminal with `npm run seed`.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = process.env.PORT ?? '8787';
const bootstrapToken = process.env.BOOTSTRAP_TOKEN ?? 'local-bootstrap-secret';
const persistDir = process.env.PERSIST_DIR ?? '.wrangler/local-state';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(npx, args, { cwd: projectRoot, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited with ${code}`))));
	});
}

console.log(`▶ Applying D1 migrations to ${persistDir} …`);
await run(['wrangler', 'd1', 'migrations', 'apply', 'voyager-dev-control', '--local', '--persist-to', persistDir]);

console.log(`▶ Starting Worker on http://127.0.0.1:${port}  (BOOTSTRAP_TOKEN=${bootstrapToken})`);
console.log('  Seed it in another terminal:  npm run seed');

const worker = spawn(
	npx,
	[
		'wrangler', 'dev', '--local',
		'--ip', '127.0.0.1',
		'--persist-to', persistDir,
		'--port', String(port),
		'--var', `BOOTSTRAP_TOKEN:${bootstrapToken}`,
		'--show-interactive-dev-session=false'
	],
	{ cwd: projectRoot, stdio: 'inherit' }
);

worker.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => worker.kill(sig));
}
