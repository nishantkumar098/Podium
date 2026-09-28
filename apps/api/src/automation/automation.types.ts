/**
 * The automation engine's vocabulary (blueprint §12).
 *
 * The ten seeded rules describe their actions as human sentences ("Create
 * project from playbook", "Notify Procurement Manager"). Rather than rewrite
 * that seed data, the engine maps each rule to a typed handler by its trigger
 * string — so the rules remain readable configuration and the executable
 * behaviour lives in code that can be tested.
 */

export type TriggerKind = "event" | "time_relative" | "threshold";

/** What actually happened, handed to the engine by the code that did it. */
export interface AutomationEvent {
  /** e.g. "lead.stage_changed:Won", "flow_step.completed". */
  trigger: string;
  workspaceId: string;
  /** The row this is about — used for the idempotency key. */
  entityId: string;
  entityType: string;
  /** Anything a condition or action needs, without re-querying. */
  payload?: Record<string, unknown>;
}

export type RunOutcome =
  | { status: "SUCCESS"; detail: Record<string, unknown> }
  /**
   * The trigger matched but the action cannot run because a human must supply
   * missing facts. Deliberately distinct from FAILED: nothing is broken, the
   * data simply isn't there, and inventing it is not an option.
   */
  | { status: "BLOCKED"; reason: string; missing: string[] }
  | { status: "FAILED"; error: string };

export interface ActionHandler {
  /** The trigger string this handler answers to. */
  readonly trigger: string;
  /** Cheap pre-check; false means the rule simply doesn't apply to this event. */
  matches(event: AutomationEvent): boolean;
  run(event: AutomationEvent, ruleId: string): Promise<RunOutcome>;
}
