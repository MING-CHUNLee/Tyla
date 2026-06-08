import * as diff from 'diff';
import chalk from 'chalk';

export type DiffLineKind = 'added' | 'removed' | 'context';

export interface DiffLine {
    kind: DiffLineKind;
    text: string;
}

export class DiffEngine {
    /**
     * Returns structured diff lines for Ink components that apply their own colours.
     */
    public generateDiffLines(oldStr: string, newStr: string): DiffLine[] {
        const differences = diff.diffLines(oldStr, newStr);

        if (differences.length === 1 && !differences[0].added && !differences[0].removed) {
            return [{ kind: 'context', text: 'No changes detected.' }];
        }

        const lines: DiffLine[] = [];
        differences.forEach((part) => {
            const kind: DiffLineKind = part.added ? 'added' : part.removed ? 'removed' : 'context';
            const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
            // Normalize CRLF → LF before splitting so Windows files don't leave a trailing
            // \r in each text string (which would cause the cursor to return to column 0 and
            // make the entire line invisible in Ink's terminal renderer).
            part.value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').forEach(line => {
                lines.push({ kind, text: `${prefix}${line}` });
            });
        });
        return lines;
    }

    /**
     * Compare two strings and return a coloured terminal output (simplified patch format).
     * Used by the CLI presenter (chalk writes directly to stdout there).
     */
    public generateColoredDiff(oldStr: string, newStr: string): string {
        const lines = this.generateDiffLines(oldStr, newStr);
        if (lines.length === 1 && lines[0].kind === 'context' && lines[0].text === 'No changes detected.') {
            return chalk.gray('No changes detected.');
        }
        return lines.map(l => {
            if (l.kind === 'added')   return chalk.green(l.text + '\n');
            if (l.kind === 'removed') return chalk.red(l.text + '\n');
            return chalk.gray(l.text + '\n');
        }).join('');
    }

    private prefixLines(text: string, prefix: string): string {
        return text
            .replace(/\n$/, '')
            .split('\n')
            .map(line => `${prefix}${line}\n`)
            .join('');
    }
}
