module.exports = {
  extends: [require.resolve('../../packages/config/eslint/nextjs.js')],
  rules: {
    'no-alert': 'error',
    'no-restricted-globals': [
      'error',
      {
        name: 'confirm',
        message: 'Use the in-app confirmation dialog for visitor actions.',
      },
    ],
  },
  overrides: [
    {
      files: ['**/*.test.{js,jsx,ts,tsx}', '**/*.spec.{js,jsx,ts,tsx}'],
      rules: {
        'no-alert': 'off',
        'no-restricted-globals': 'off',
      },
    },
  ],
}
