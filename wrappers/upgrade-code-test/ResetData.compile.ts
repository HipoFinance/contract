import { CompilerConfig } from '@ton-community/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['wrappers/upgrade-code-test/reset_data.fc'],
}
