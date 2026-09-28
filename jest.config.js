/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          target: 'ES2020',
          lib: ['ES2020', 'DOM'],
          strict: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
