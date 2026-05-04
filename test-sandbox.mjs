import { Sandbox } from '@vercel/sandbox';

async function main() {
  try {
    console.log("Creating sandbox with node24...");
    const sandbox = await Sandbox.create({
      runtime: 'node24',
      timeout: 1000 * 60,
      source: {
        type: 'git',
        url: 'https://github.com/makinary/apps.git', // dummy
        username: 'x-access-token',
        password: process.env.GITHUB_TOKEN || 'dummy',
      },
    });
    console.log("Success:", sandbox.sandboxId);
    if (typeof sandbox.stop === 'function') await sandbox.stop();
  } catch (err) {
    console.error("Error creating sandbox node24:", err.message);
  }

  try {
    console.log("Creating sandbox with node20...");
    const sandbox2 = await Sandbox.create({
      runtime: 'node20',
      timeout: 1000 * 60,
      source: {
        type: 'git',
        url: 'https://github.com/makinary/apps.git', // dummy
        username: 'x-access-token',
        password: process.env.GITHUB_TOKEN || 'dummy',
      },
    });
    console.log("Success:", sandbox2.sandboxId);
    if (typeof sandbox2.stop === 'function') await sandbox2.stop();
  } catch (err) {
    console.error("Error creating sandbox node20:", err.message);
  }
}
main();
