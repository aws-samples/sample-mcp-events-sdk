/** SEP-3415 extension id. */
export const EVENTS_EXT = 'io.modelcontextprotocol/events';

/**
 * Placeholder namespace for the companion extensions (spec §0, open question 10).
 * Change it here only; every extension id and `_meta` key derives from it.
 */
export const NS = 'org.agentevents';

export const EXT = {
  contract: `${NS}/event-contract`,
  situations: `${NS}/situations`,
  activation: `${NS}/activation`,
  actions: `${NS}/actions`,
  rules: `${NS}/rules`,
} as const;

export const SPEC_VERSION = '0.1';
