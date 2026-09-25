export {
  type EnvScope,
  getSink,
  type HookSink,
  installHooks,
  observeEnv,
  observeSourceIn,
  type PathKind,
  type PathType,
  type RawFs,
  type Reader,
  rawFs,
  replayTrace,
  setSink,
  unobserved,
} from './hooks.ts'
export { type MainObservations, MainRecorder } from './main.ts'
export type { PayloadModule, WorkerPayload } from './payload.ts'
export { parseTrace } from './trace.ts'

/**
 * Variables whose values differ on every run or every worker and never carry meaning a test may
 * depend on. Reads of these are not recorded.
 */
export const VOLATILE_ENV =
  /^(VITEST_WORKER_ID|VITEST_POOL_ID|JEST_WORKER_ID|VEYRUM_.*|GITHUB_(SHA|REF|REF_NAME|REF_TYPE|RUN_ID|RUN_NUMBER|RUN_ATTEMPT|JOB|ACTION|ACTION_PATH|ACTION_REF|ACTION_REPOSITORY|ACTIONS|HEAD_REF|BASE_REF|EVENT_NAME|EVENT_PATH|OUTPUT|STATE|ENV|PATH|STEP_SUMMARY|ARTIFACTS|ARTIFACTS_LIST|WORKFLOW|WORKFLOW_REF|WORKFLOW_SHA|RETENTION_DAYS|TRIGGERING_ACTOR|ACTOR|ACTOR_ID)|RUNNER_.*|ACTIONS_.*|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|OLDPWD|_|SHLVL|npm_.*|PNPM_SCRIPT_SRC_DIR|INIT_CWD|COLUMNS|LINES|TERM_SESSION_ID|WT_SESSION|SUDO_COMMAND|WSLENV|SSH_.*|DISPLAY|XDG_SESSION_.*|DBUS_SESSION_BUS_ADDRESS|MOTD_SHOWN)$/
