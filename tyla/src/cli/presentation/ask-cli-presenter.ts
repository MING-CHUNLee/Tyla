/**
 * Presentation: AskCliAdapter
 *
 * CLI adapter for `tyla ask "..."`.
 *
 * Strict clean:
 * - no imports from infrastructure/
 * - controller is injected via composition root
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora, { Ora } from 'ora';

import type { AgentService, AgentEvent } from '../../application/services/agent-service';
import { displayStatusBar } from './views/context-status-bar';
import type { StatusBarItemKey } from '../../shared/view-models';

export interface AskCliAdapterDeps {
    /** Composition root: build a fully wired AgentController. */
    createController: (args: {
        directory: string;
        viewAdapter: (event: AgentEvent) => void;
    }) => AgentService;

    /** Status bar item order (typically loaded from user settings). */
    statusBarItems: StatusBarItemKey[];
}

export interface AskOptions {
    directory: string;
    resume: boolean;
    session?: string;
    new: boolean;
}

export function createAskCommand(deps: AskCliAdapterDeps): Command {
    return new Command('ask')
        .description('Ask a question about the codebase without modifying any files')
        .argument('<question>', 'The question you want to ask')
        .option('-d, --directory <path>', 'Workspace directory to scan', process.env['INIT_CWD'] ?? process.cwd())
        .option('--resume', 'Resume the last saved session', false)
        .option('--session <id>', 'Resume a specific session by ID')
        .option('--new', 'Force a new session (ignore last)', false)
        .action(async (question: string, options: AskOptions) => {
            await executeAskCommand(deps, question, options);
        });
}

async function executeAskCommand(
    deps: AskCliAdapterDeps,
    question: string,
    options: AskOptions,
): Promise<void> {
    let spinner: Ora | null = null;

    const controller = deps.createController({
        directory: options.directory,
        viewAdapter: (event: AgentEvent) => {
            handleEvent(event, spinner, s => { spinner = s; });
        },
    });

    await controller.initialize({
        sessionId: options.session,
        forceNew:  options.new,
    });

    if (options.new) {
        const sessionId = controller.getSession().id;
        console.log(chalk.dim(`\n  New session ${sessionId.slice(-6)}`));
    }

    console.log(chalk.blue(`\n❓ Question: "${question}"\n`));

    await controller.executeAsk(question);

    const session = controller.getSession();
    displayStatusBar(
        {
            model:               session.model,
            usagePercent:        session.tokenBudget.usagePercent,
            health:              session.tokenBudget.health,
            totalCostUSD:        session.totalCostUSD,
            turnCount:           session.turnCount,
            requestsPerMinute:   session.requestsPerMinute,
            lastTokensPerSecond: session.lastTokensPerSecond,
            lastResponseTimeMs:  session.lastResponseTimeMs,
            elapsedMs:           session.elapsedMs,
        },
        { items: deps.statusBarItems },
    );
}

// ── Event → terminal renderer ─────────────────────────────────────────────────

function handleEvent(
    event: AgentEvent,
    currentSpinner: Ora | null,
    setSpinner: (s: Ora | null) => void,
): void {
    switch (event.type) {
        case 'phase_start': {
            const desc = String((event.data as { description?: unknown; phase?: unknown }).description
                ?? (event.data as { phase?: unknown }).phase);
            setSpinner(ora(desc).start());
            break;
        }
        case 'phase_end': {
            if (currentSpinner) {
                (event.data as { success?: boolean }).success ? currentSpinner.succeed() : currentSpinner.fail();
                setSpinner(null);
            }
            if ((event.data as { phase?: string }).phase === 'ask') {
                console.log('\n======================================================\n');
            }
            break;
        }
        case 'stream_token': {
            if (currentSpinner) {
                currentSpinner.stop();
                setSpinner(null);
                console.log('\n======================================================');
            }
            process.stdout.write(chalk.green(String((event.data as { token?: unknown }).token ?? '')));
            break;
        }
        case 'status_update': {
            const warning = (event.data as { warning?: string }).warning;
            if (warning) {
                console.log(chalk.yellow(`  ⚠  ${warning}`));
            }
            break;
        }
        case 'error': {
            if (currentSpinner) { currentSpinner.fail(); setSpinner(null); }
            console.error(chalk.red(`\n  ✖  ${(event.data as { message?: string }).message ?? ''}`));
            break;
        }
        default:
            break;
    }
}
