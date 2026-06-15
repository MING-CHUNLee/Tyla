/**
 * Domain Entity: ConversationSession  (Aggregate Root)
 *
 * Tracks the full history of a multi-turn agent conversation:
 *   - Ordered list of ConversationTurns (append-only)
 *   - Cumulative token / cache stats (for cost display)
 *   - Latest-turn context window health (for "Context Anxiety" monitoring)
 *
 * All mutation happens through addTurn() — no direct array access.
 */

import { ConversationTurn, TurnUsage, TurnJSON, ApiLogEntry } from './conversation-turn';
import { FileChange, FileChangeType } from './file-change';
import { LLMOutput, LLMOutputType } from '../values/llm-output';
import { TokenBudget, TokenUsageSnapshot } from '../values/token-budget';
import { CacheStatus } from '../values/cache-status';

export interface SessionMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface CumulativeUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCostUSD: number;
}

export interface SessionJSON {
    id: string;
    model: string;
    startedAt: string;
    turns: TurnJSON[];
}

export class ConversationSession {
    private readonly _turns: ConversationTurn[];
    private _cumulative: CumulativeUsage;

    constructor(
        readonly id: string,
        readonly model: string,
        readonly startedAt: Date = new Date(),
        turns: ConversationTurn[] = [],
    ) {
        this._turns = [];
        this._cumulative = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCostUSD: 0 };
        // Replay loaded turns to rebuild cumulative stats
        for (const t of turns) {
            this._turns.push(t);
            this.accumulate(t.usage);
        }
    }

    // ── Read ────────────────────────────────────────────────────────────

    get turns(): ReadonlyArray<ConversationTurn> { return this._turns; }
    get turnCount(): number { return this._turns.length; }

    /**
     * Context window health based on the *latest* turn's input tokens.
     * This is what the user sees on the status bar — how full is the
     * current context window right now?
     */
    get tokenBudget(): TokenBudget {
        const latest = this._turns.at(-1);
        const snapshot: TokenUsageSnapshot = latest
            ? { ...latest.usage }
            : { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
        return new TokenBudget(snapshot, this.model);
    }

    /**
     * Cumulative cache metrics across the whole session.
     */
    get cacheStatus(): CacheStatus {
        return new CacheStatus(
            this._cumulative.cacheCreationTokens,
            this._cumulative.cacheReadTokens,
            this._cumulative.inputTokens,
            this.model,
        );
    }

    /** Cumulative USD cost for the entire session */
    get totalCostUSD(): number { return this._cumulative.totalCostUSD; }

    /** Milliseconds since session started */
    get elapsedMs(): number { return Date.now() - this.startedAt.getTime(); }

    /** Rolling requests per minute based on turn timestamps */
    get requestsPerMinute(): number {
        if (this._turns.length === 0) return 0;
        const elapsedMin = this.elapsedMs / 60_000;
        return elapsedMin > 0 ? +(this._turns.length / elapsedMin).toFixed(1) : 0;
    }

    /** Output tokens per second for the last turn (undefined if no timing data) */
    get lastTokensPerSecond(): number | undefined {
        const last = this._turns.at(-1);
        if (!last?.usage.responseTimeMs || last.usage.responseTimeMs <= 0) return undefined;
        return +(last.usage.outputTokens / (last.usage.responseTimeMs / 1_000)).toFixed(1);
    }

    /** Last turn's response latency in ms (undefined if no timing data) */
    get lastResponseTimeMs(): number | undefined {
        return this._turns.at(-1)?.usage.responseTimeMs;
    }

    /**
     * Flattened [user, assistant, user, assistant, …] history
     * ready to be passed as LLMRequest.history.
     */
    getHistory(): SessionMessage[] {
        return this._turns.flatMap(t => t.toHistoryMessages());
    }

    // ── Write ───────────────────────────────────────────────────────────

    addTurn(
        userMessage: string,
        assistantMessage: string,
        usage: TurnUsage,
        fileChanges?: FileChange[],
        outputs?: LLMOutput[],
        apiLogs?: ApiLogEntry[],
    ): ConversationTurn {
        const turn = new ConversationTurn(
            this._turns.length + 1,
            userMessage,
            assistantMessage,
            usage,
            undefined,
            fileChanges ?? [],
            outputs ?? [],
            apiLogs ?? [],
        );
        this._turns.push(turn);
        this.accumulate(usage);
        return turn;
    }

    /** Return all FileChanges across all turns, optionally filtered by type. */
    getFileChanges(type?: FileChangeType): FileChange[] {
        const all = this._turns.flatMap(t => t.fileChanges);
        return type ? all.filter(fc => fc.type === type) : all;
    }

    /** Return all LLMOutputs across all turns, optionally filtered by type. */
    getOutputs(type?: LLMOutputType): LLMOutput[] {
        const all = this._turns.flatMap(t => t.outputs);
        return type ? all.filter(o => o.type === type) : all;
    }

    // ── Checkpoint / Rollback ────────────────────────────────────────────

    /**
     * Create a lightweight checkpoint by returning the current turn count.
     * Callers should persist this before a risky multi-step operation so
     * they can call rollbackTo() if it fails.
     *
     * @returns The checkpoint handle (= current turn count, 0-based exclusive)
     */
    checkpoint(): number {
        return this._turns.length;
    }

    /**
     * Roll back the session to the state immediately after turn `turnNumber`.
     * All turns with index >= turnNumber are removed and cumulative stats
     * are recomputed from scratch.
     *
     * @param turnNumber  0 = empty session; N = keep first N turns
     */
    rollbackTo(turnNumber: number): void {
        if (turnNumber < 0 || turnNumber > this._turns.length) {
            throw new RangeError(
                `Invalid rollback target ${turnNumber}. ` +
                `Session has ${this._turns.length} turn(s); valid range: 0–${this._turns.length}.`,
            );
        }
        // Truncate turns array in-place
        this._turns.splice(turnNumber);
        // Recompute cumulative stats from the surviving turns
        this._cumulative = {
            inputTokens: 0, outputTokens: 0,
            cacheCreationTokens: 0, cacheReadTokens: 0,
            totalCostUSD: 0,
        };
        for (const t of this._turns) this.accumulate(t.usage);
    }

    // ── Serialization ───────────────────────────────────────────────────

    toJSON(): SessionJSON {
        return {
            id: this.id,
            model: this.model,
            startedAt: this.startedAt.toISOString(),
            turns: this._turns.map(t => t.toJSON()),
        };
    }

    static fromJSON(data: SessionJSON): ConversationSession {
        const turns = data.turns.map(t => ConversationTurn.fromJSON(t));
        return new ConversationSession(data.id, data.model, new Date(data.startedAt), turns);
    }

    static create(model: string): ConversationSession {
        const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return new ConversationSession(id, model);
    }

    // ── Private ─────────────────────────────────────────────────────────

    private accumulate(usage: TurnUsage): void {
        this._cumulative.inputTokens         += usage.inputTokens;
        this._cumulative.outputTokens        += usage.outputTokens;
        this._cumulative.cacheCreationTokens += usage.cacheCreationTokens;
        this._cumulative.cacheReadTokens     += usage.cacheReadTokens;
        // Accumulate cost from each turn's budget
        this._cumulative.totalCostUSD += new TokenBudget(usage, this.model).estimatedCostUSD;
    }
}
