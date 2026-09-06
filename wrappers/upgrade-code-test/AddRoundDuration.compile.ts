import { CompilerConfig } from '@ton/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['wrappers/upgrade-code-test/add_round_duration.fc'],
}
