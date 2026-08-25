// Minimal ANSI colouring, with no dependency and an explicit off switch.
//
// Colour is decided once, from the environment, and then carried around as a palette rather than
// re-read at each call site. That keeps rendering testable: a test can ask for a palette that is
// definitely on or definitely off, instead of depending on how the test runner attaches stdout.
//
// Off by default whenever output is not a terminal, because this output gets piped into deploy
// records and pasted to co-signers, where escape codes are noise. NO_COLOR disables it even on a
// terminal; FORCE_COLOR enables it even when piped.

const ESC = '\u001b['

function detect(): boolean {
    if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false
    const forced = process.env.FORCE_COLOR
    if (forced != null && forced !== '' && forced !== '0') return true
    if (process.env.TERM === 'dumb') return false
    return process.stdout.isTTY
}

function wrap(code: string, text: string, on: boolean): string {
    return on ? ESC + code + 'm' + text + ESC + '0m' : text
}

export function makePalette(on: boolean = detect()) {
    return {
        enabled: on,
        red: (s: string) => wrap('31', s, on),
        green: (s: string) => wrap('32', s, on),
        yellow: (s: string) => wrap('33', s, on),
        cyan: (s: string) => wrap('36', s, on),
        grey: (s: string) => wrap('90', s, on),
        bold: (s: string) => wrap('1', s, on),
        redBold: (s: string) => wrap('1;31', s, on),
        yellowBold: (s: string) => wrap('1;33', s, on),
        greenBold: (s: string) => wrap('1;32', s, on),
    }
}

export type Palette = ReturnType<typeof makePalette>
