/**
 * Presentation: AgentCliPresenter
 *
 * Pure CLI rendering — chalk/ora/readline event handlers for the
 * `tyla agent "instruction"` one-shot usage.
 *
 * Responsibilities (presentation only):
 * - Build viewAdapter (chalk, ora, console.log)
 * - Build approvalGate (readline)
 * - Define Commander command shape
 *
 * Execution logic (spinner state + AgentService calls) lives in
 * cli/controller/cli-agent-controller.ts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';

import type { AgentEvent, ProposedEdit, ProposedInstall, EventCallback, ApprovalCallback, InstallApprovalCallback } from '../../application/services/agent-service';
import { createRollbackCommand, type RollbackCliPresenterDeps } from './rollback-cli-presenter';
import type { StatusBarItemKey } from '../../shared/view-models';
import { CliAgentController, type CliAgentControllerDeps, type AgentOptions } from '../controller/cli-agent-controller';

export interface AgentCliPresenterDeps extends CliAgentControllerDeps, RollbackCliPresenterDeps {
    statusBarItems: StatusBarItemKey[];
}

// ── Pure rendering builders ───────────────────────────────────────────────────

export function buildViewAdapter(
    instruction: string,
    ctrl: CliAgentController,
): EventCallback {
    return (event: AgentEvent): void => {
        switch (event.type) {
            case 'session_loaded': {
                const { sessionId, turnCount } = event.data as { sessionId: string; turnCount: number };
                if (turnCount > 0) {
                    console.log(chalk.cyan(`\n↩  Resuming session ${(sessionId as string).slice(-6)} (${turnCount} previous turns)`));
                } else {
                    console.log(chalk.dim(`\n  New session ${(sessionId as string).slice(-6)}`));
                }
                const mode = ctrl.getMode();
                if (mode && mode !== 'default') {
                    console.log(chalk.bold.cyan(`  [Mode: ${mode}]`));
                }
                break;
            }
            case 'intent_classified':
                ctrl.getSpinner()?.succeed(`Intent classified as: ${chalk.cyan(event.data.intent)}`);
                ctrl.setSpinner(null);
                if (event.data.intent === 'edit') {
                    console.log(chalk.blue(`\n🤖 Instruction: "${instruction}"\n`));
                }
                break;
            case 'phase_start':
                ctrl.setSpinner(ora(event.data.description as string).start());
                break;
            case 'phase_end':
                if (event.data.success) {
                    ctrl.getSpinner()?.succeed(event.data.summary as string ?? (event.data.phase as string) + ' done');
                } else {
                    ctrl.getSpinner()?.fail((event.data.phase as string) + ' failed');
                }
                ctrl.setSpinner(null);
                break;
            case 'react_step': {
                const { thought, action, observation } = event.data;
                if (thought) console.log(chalk.dim(`  [Step] ${(thought as string).slice(0, 120)}`));
                if (action) console.log(chalk.cyan(`    → Tool: ${(action as { tool: string }).tool}`));
                if (observation) console.log(chalk.gray(`    ← ${(observation as string).slice(0, 100)}`));
                break;
            }
            case 'text_output':
                console.log('\n======================================================');
                console.log(chalk.green(event.data.content as string));
                console.log('======================================================\n');
                break;
            case 'stream_token':
                process.stdout.write(chalk.green(event.data.token as string));
                break;
            case 'diff_proposed':
                console.log(chalk.bold(`\n📄 ${event.data.path}`));
                console.log(chalk.dim('─'.repeat(56)));
                console.log(event.data.diff as string);
                console.log(chalk.dim('─'.repeat(56)));
                break;
            case 'edit_applied':
                console.log(chalk.green(`✓ Written: ${event.data.path}`));
                break;
            case 'edit_rejected':
                console.log(chalk.yellow(`✗ Rejected: ${event.data.path} — disk untouched`));
                break;
            case 'turn_saved':
                console.log(chalk.blue('\n✅ Agent workflow complete.'));
                break;
            case 'status_update':
                if (event.data.plugins) {
                    console.log(chalk.dim(`  Plugins: ${(event.data.plugins as string[]).join(', ')}`));
                }
                if (event.data.knowledge) {
                    console.log(chalk.dim(`  Knowledge: ${(event.data.knowledge as string[]).join(', ')}`));
                }
                break;
            case 'install_proposed': {
                const d = event.data as unknown as ProposedInstall;
                console.log(chalk.bold.cyan('\n📦 Package Installation Plan'));
                console.log(chalk.dim('─'.repeat(48)));
                if (d.toInstall.length > 0) {
                    console.log(chalk.green(`To install: ${d.toInstall.join(', ')}`));
                }
                if (d.alreadyInstalled.length > 0) {
                    console.log(chalk.gray(`Already installed: ${d.alreadyInstalled.join(', ')}`));
                }
                d.warnings.forEach(w => console.log(chalk.yellow(`  ⚠  ${w.name}: ${w.message}`)));
                d.blocked.forEach(b => console.log(chalk.red(`  ✗  ${b.name}: ${b.reason}`)));
                console.log(chalk.dim('─'.repeat(48)));
                break;
            }
            case 'error':
                console.error(chalk.red(`Error [${event.data.phase}]: ${event.data.message}`));
                break;
        }
    };
}

export function buildApprovalGate(): ApprovalCallback {
    return async (edit: ProposedEdit): Promise<boolean> =>
        promptConfirm(`Apply changes to ${chalk.cyan(edit.path)}? [Y/n] `);
}

export function buildInstallApprovalGate(): InstallApprovalCallback {
    return async (plan: ProposedInstall): Promise<boolean> => {
        const summary = plan.toInstall.length > 0
            ? `${plan.toInstall.join(', ')}`
            : 'no new packages';
        return promptConfirm(`Install ${chalk.cyan(summary)}? [Y/n] `);
    };
}

// ── Command Definition ────────────────────────────────────────────────────────

export function createAgentCommand(deps: AgentCliPresenterDeps): Command {
    return new Command('agent')
        .description('Run Agent to edit files based on natural language instruction')
        .argument('<instruction>', 'What the agent should do')
        .option('-d, --directory <path>', 'Workspace directory to scan', process.env['INIT_CWD'] ?? process.cwd())
        .option('--resume', 'Resume the last saved session', false)
        .option('--session <id>', 'Resume a specific session by ID')
        .option('--new', 'Force a new session (ignore last)', false)
        .addHelpText('after', `
Examples:
  # New session
  $ tyla agent "Add error handling to the scanner"

  # Resume last session (agent remembers previous changes)
  $ tyla agent "Now add tests for those changes" --resume

  # Resume a specific session
  $ tyla agent "Continue the refactor" --session abc123
    `)
        .action(async (instruction: string, options: AgentOptions) => {
            const ctrl = new CliAgentController(deps);
            const viewAdapter = buildViewAdapter(instruction, ctrl);
            const approvalGate = buildApprovalGate();
            const installApprovalGate = buildInstallApprovalGate();
            await ctrl.execute(instruction, options, viewAdapter, approvalGate, installApprovalGate);
        })
        .addCommand(createRollbackCommand({ repo: deps.repo }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function promptConfirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(chalk.yellow(question), answer => {
            rl.close();
            const n = answer.trim().toLowerCase();
            resolve(n === '' || n === 'y' || n === 'yes');
        });
    });
}
