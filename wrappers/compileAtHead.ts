import { compileFunc } from '@ton-community/func-js'
import { Cell } from '@ton/core'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, normalize, dirname } from 'path'

// Compiles a FunC contract from the committed tree rather than the working tree.
//
// A storage migration can only be tested honestly against the code that is actually deployed, and
// the deployed code is whatever was last committed -- the working tree is, by definition, the change
// the migration exists to land. Blueprint's compile() always reads the working tree, so this feeds
// func-js the git blobs instead.
//
// Paths are resolved relative to the repo root, exactly as the #include lines in contracts/ expect.
// Anything git cannot produce falls back to the working tree, which is what makes this usable for a
// brand-new file that the migration itself adds.

const root = normalize(join(__dirname, '..'))

function atHead(path: string): string | undefined {
    try {
        return execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
        return undefined
    }
}

export async function compileAtHead(entry: string): Promise<Cell> {
    const result = await compileFunc({
        targets: [entry],
        sources: (path: string) => {
            // func-js hands back paths relative to the target's own directory for #include lines.
            const rel = normalize(path).replace(root + '/', '')
            const fromGit = atHead(rel)
            if (fromGit != null) return fromGit
            return readFileSync(join(root, rel), 'utf8')
        },
    })
    if (result.status === 'error') {
        throw new Error(`compileAtHead(${entry}) failed: ${result.message}`)
    }
    return Cell.fromBase64(result.codeBoc)
}

export { dirname }
