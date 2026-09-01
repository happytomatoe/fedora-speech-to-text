// Metrics-only ESLint config: complexity rules for gnome-ext/.
// oxlint remains the project linter; this config exists solely for `just metrics`.
import sonarjs from 'eslint-plugin-sonarjs';

export default [
    {
        files: ['gnome-ext/**/*.js'],
        ignores: ['gnome-ext/vendor/**', 'gnome-ext/**/*.mjs'],
        plugins: { sonarjs },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
        },
        linterOptions: {
            // eslint's built-in reportUnusedDisableDirectives fires on the inline
            // directives meant for the project's oxlint rules; suppress so only
            // sonarjs findings are counted in the metrics report.
            reportUnusedDisableDirectives: 'off',
        },
        rules: {
            'sonarjs/cognitive-complexity': ['warn', 22],
            'sonarjs/cyclomatic-complexity': ['warn', { threshold: 22 }],
        },
    },
];
