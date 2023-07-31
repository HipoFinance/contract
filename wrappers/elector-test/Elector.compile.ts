import { CompilerConfig } from '@ton-community/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['wrappers/elector-test/elector-code.fc'],
}
