// Builds the app and publishes dist/ to the gh-pages branch of the `origin` remote.
// Usage: npm run deploy
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const run = (cmd, cwd = '.') => execSync(cmd, { cwd, stdio: 'inherit' });
const remote = execSync('git remote get-url origin').toString().trim();
const rev = execSync('git rev-parse --short HEAD').toString().trim();

run('npm run build');
writeFileSync('dist/.nojekyll', '');
rmSync('dist/.git', { recursive: true, force: true });
run('git init -q -b gh-pages', 'dist');
run('git add -A', 'dist');
run(`git commit -q -m "Deploy ${rev}"`, 'dist');
run(`git push -q -f ${remote} gh-pages`, 'dist');
rmSync('dist/.git', { recursive: true, force: true });
console.log(`Deployed ${rev} to gh-pages`);
