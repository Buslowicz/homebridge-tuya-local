const {readdirSync} = require('node:fs');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');

function check(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) check(path);
        else if (entry.name.endsWith('.js')) {
            const result = spawnSync(process.execPath, ['--check', path], {stdio: 'inherit'});
            if (result.error) throw result.error;
            if (result.status !== 0) process.exit(result.status || 1);
        }
    }
}

check('.');
console.log('JavaScript syntax checks passed.');
