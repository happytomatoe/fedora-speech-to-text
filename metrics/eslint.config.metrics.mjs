// Metrics-only ESLint config: complexity rules for gnome-ext/.
// oxlint remains the project linter; this config exists solely for `just metrics`.
import sonarjs from 'eslint-plugin-sonarjs';

export default [
    {
        files: ['gnome-ext/**/*.js'],
        plugins: { sonarjs },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
        },
        rules: {
            'sonarjs/cognitive-complexity': ['warn', 22],
            'sonarjs/cyclomatic-complexity': ['warn', { threshold: 22 }],
        },
    },
];
