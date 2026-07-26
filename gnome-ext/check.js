#!/usr/bin/env node

// Quick validation of compiled JavaScript files
import {readFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');

const files = ['extension.js', 'indicator.js', 'hotkey.js', 'typer.js'];
let errors = 0;

for (const file of files) {
    try {
        const content = readFileSync(join(distDir, file), 'utf8');

        // Check for common GObject + TypeScript issues
        if (content.includes('private ')) {
            console.error(
                `❌ ${file}: Contains 'private' keyword (won't work with GObject)`
            );
            errors++;
        }

        if (content.includes('!:') || content.includes('!: ')) {
            console.error(
                `❌ ${file}: Contains '!:' assertion (won't work with GObject)`
            );
            errors++;
        }

        // Check that _init() is called
        if (file === 'indicator.js' && !content.includes('_init()')) {
            console.error(`❌ ${file}: Missing _init() method`);
            errors++;
        }

        // Check for null initializations before _buildUI
        if (file === 'indicator.js') {
            const initMatch = content.match(
                /_init\(\)\s*\{[\s\S]*?_buildUI\(\)/
            );
            if (initMatch) {
                const initCode = initMatch[0];
                if (
                    !initCode.includes('_recording = false') ||
                    initCode.indexOf('_recording = false') >
                        initCode.indexOf('_buildUI()')
                ) {
                    console.error(
                        `❌ ${file}: _recording must be initialized BEFORE _buildUI()`
                    );
                    errors++;
                }
            }
        }

        if (errors === 0) {
            console.log(`✅ ${file}: OK`);
        }
    } catch (e) {
        console.error(`❌ ${file}: ${e.message}`);
        errors++;
    }
}

if (errors > 0) {
    console.error(`\n❌ Found ${errors} issue(s)`);
    process.exit(1);
} else {
    console.log('\n✅ All checks passed');
}
