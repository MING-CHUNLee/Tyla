/**
 * Application Service: Late-binding event / approval buses
 *
 * These thin objects are created at factory (composition-root) time and
 * injected into all use cases that need emit or approval callbacks.
 * The AgentController calls .bind() in its constructor to wire them to the
 * concrete presentation-layer callbacks (viewAdapter, approvalGate, etc.).
 *
 * This lets the factory fully assemble use cases before the controller —
 * and thus before the presentation layer — is constructed.
 */

type EmitFn = (type: string, data: Record<string, unknown>) => void;

export type ApprovalCb = (edit: { path: string; diff: string; diffLines: import('./diff-engine').DiffLine[]; original: string; proposed: string }) => Promise<boolean>;
export type InstallApprovalCb = (plan: { toInstall: string[]; alreadyInstalled: string[]; blocked: Array<{ name: string; reason: string }>; warnings: Array<{ name: string; message: string }> }) => Promise<boolean>;

// ── EventBus ──────────────────────────────────────────────────────────────────

export class EventBus {
    private cb: EmitFn = () => {};

    /** Wire the bus to the presentation-layer view adapter. Called once by the controller. */
    bind(cb: EmitFn): void {
        this.cb = cb;
    }

    emit(type: string, data: Record<string, unknown>): void {
        this.cb(type, data);
    }
}

// ── ApprovalBus ───────────────────────────────────────────────────────────────

export class ApprovalBus {
    private cb: ApprovalCb = async () => false;

    /** Wire the bus to the presentation-layer approval gate. Called once by the controller. */
    bind(cb: ApprovalCb): void {
        this.cb = cb;
    }

    approve: ApprovalCb = (edit) => this.cb(edit);
}

// ── InstallApprovalBus ────────────────────────────────────────────────────────

export class InstallApprovalBus {
    private cb?: InstallApprovalCb;

    /** Wire the bus to the presentation-layer install approval gate. Optional. */
    bind(cb: InstallApprovalCb): void {
        this.cb = cb;
    }

    /** Returns undefined when not bound so ExecuteInstallUseCase skips the gate entirely. */
    getCallback(): InstallApprovalCb | undefined {
        return this.cb;
    }
}
