import { CompilerConfig } from '@ton/blueprint'

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['wrappers/storage-cost/storage_cost.fc'],
}
