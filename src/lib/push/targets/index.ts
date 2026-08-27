import type { PushTargetRegistry } from "../service";
import { jiraTarget } from "./jira";
import { linearTarget } from "./linear";
import { notionTarget } from "./notion";

/**
 * Every destination a push can reach, keyed by provider.
 *
 * The registry is a value the orchestrator is handed rather than a module it
 * imports, which is what lets the service tests drive fake targets and what
 * makes a fourth provider one module plus one line here. `PushTargetRegistry`
 * covers every `Provider`, so adding an enum member without a module is a
 * compile error rather than an undefined lookup at push time.
 */
export const pushTargets: PushTargetRegistry = {
  JIRA: jiraTarget,
  LINEAR: linearTarget,
  NOTION: notionTarget,
};
