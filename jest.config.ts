import type { Config } from 'jest'

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup-jest.ts'],
    slowTestThreshold: 60,
    testTimeout: 10000,
    workerThreads: true,
}

export default config
