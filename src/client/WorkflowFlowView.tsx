/**
 * The session view registered into `conversation.view`: a horizontal flow of
 * step cards connected by status-colored lines. Starting a workflow happens
 * from the conversation composer via the `/ub-workflow` slash command; this
 * view is the live monitoring surface plus gate-confirmation controls.
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepStatus, WorkflowStep } from '../core/types.ts'
import { useWorkflowRun } from './useWorkflowRun.ts'
import { StepCard } from './StepCard.tsx'
import { type UbWorkflowKey } from './locales.ts'
import css from './workflow-flow.module.css'

const SERVER_NS = 'ub-workflow'

export type WorkflowFlowViewProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'ub-workflow'>

const STATUS_TEXT_KEY: Record<StepStatus, UbWorkflowKey> = {
  pending: 'status.pending',
  running: 'status.running',
  waiting_user: 'status.waiting_user',
  done: 'status.done',
  failed: 'status.failed',
  skipped: 'status.skipped',
}

const CONNECTOR_STATUS: Record<StepStatus, string> = {
  pending: 'pending',
  running: 'running',
  waiting_user: 'waiting',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

export function WorkflowFlowView(props: WorkflowFlowViewProps): ReactNode {
  const { t } = props
  const ctrl = useWorkflowRun(1500)
  const [busyGate, setBusyGate] = useState<string | null>(null)

  const snapshot = ctrl.snapshot
  const active = snapshot?.activeRun ?? null

  const statusLabel = (status: StepStatus): string => t(STATUS_TEXT_KEY[status])

  const gate = async (runId: string, stepId: WorkflowStep['id'], action: 'confirm' | 'cancel'): Promise<void> => {
    setBusyGate(runId)
    try {
      await ctrl.resolveGate({ runId, stepId, action })
    } finally {
      setBusyGate(null)
    }
  }

  const hasHistory = (snapshot?.runs.length ?? 0) > 0

  const flow = useMemo(() => {
    if (active === null) return null
    return (
      <div className={css.flow}>
        {active.steps.map((step, index) => {
          const stepNode = step.id === 'develop' && step.substeps !== undefined && step.substeps.length > 0
            ? (
                <div className={css.developGroup}>
                  <StepCard
                    step={step}
                    statusLabel={statusLabel}
                    userNeededLabel={t('userNeeded')}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    artifactsLabel={t('artifacts')}
                    noArtifactsLabel={t('noArtifacts')}
                    gateHint={t('gateConfirmHint')}
                    gateDoneHint={t('gateDone')}
                    busy={busyGate === active.runId}
                    onConfirm={() => { void gate(active.runId, step.id, 'confirm') }}
                    onCancel={() => { void gate(active.runId, step.id, 'cancel') }}
                  />
                  <div className={css.substeps}>
                    {step.substeps.map((sub, subIndex) => (
                      <Fragment key={sub.id}>
                        {subIndex > 0
                          ? <div className={css.miniConnector} data-status={CONNECTOR_STATUS[sub.status]} />
                          : null}
                        <StepCard
                          step={sub}
                          compact
                          statusLabel={statusLabel}
                          userNeededLabel={t('userNeeded')}
                          confirmLabel={t('confirm')}
                          cancelLabel={t('cancel')}
                          artifactsLabel={t('artifacts')}
                          noArtifactsLabel={t('noArtifacts')}
                          gateHint={t('gateConfirmHint')}
                          gateDoneHint={t('gateDone')}
                        />
                      </Fragment>
                    ))}
                  </div>
                </div>
              )
            : (
                <StepCard
                  step={step}
                  statusLabel={statusLabel}
                  userNeededLabel={t('userNeeded')}
                  confirmLabel={t('confirm')}
                  cancelLabel={t('cancel')}
                  artifactsLabel={t('artifacts')}
                  noArtifactsLabel={t('noArtifacts')}
                  gateHint={t('gateConfirmHint')}
                  gateDoneHint={t('gateDone')}
                  busy={busyGate === active.runId}
                  onConfirm={() => { void gate(active.runId, step.id, 'confirm') }}
                  onCancel={() => { void gate(active.runId, step.id, 'cancel') }}
                />
              )

          return (
            <Fragment key={step.id}>
              {index > 0
                ? <div className={css.connector} data-status={CONNECTOR_STATUS[step.status]} />
                : null}
              {stepNode}
            </Fragment>
          )
        })}
      </div>
    )
  }, [active, busyGate, t]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={css.view}>
      <header className={css.topbar}>
        <div className={css.heading}>
          <h2 className={css.title}>{t('title')}</h2>
          <span className={css.tagline}>{t('tagline')}</span>
        </div>
        {active !== null
          ? (
              <div className={css.actions}>
                <button
                  type="button"
                  className={css.stopButton}
                  onClick={() => { void ctrl.stop(active.runId) }}
                >
                  {t('stop')}
                </button>
              </div>
            )
          : null}
      </header>

      {ctrl.error !== null
        ? <p className={css.error}>{t('refreshFailed')}: {ctrl.error}</p>
        : null}

      {active === null
        ? (
            <div className={css.helpCard}>
              <p className={css.helpLead}>{t('startFirst')}</p>
              <p className={css.helpHint}>{t('commandHint')}</p>
              <code className={css.command}>{t('commandUsage')}</code>
              <p className={css.helpHint}>{t('commandArgsHint')}</p>
            </div>
          )
        : null}

      {active !== null && flow !== null
        ? (
            <>
              <div className={css.runMeta}>
                <span className={css.runId}>{t('activeRun')} · {active.changeId ?? ''}</span>
                <span className={css.runStatus}>{statusLabel(runStatusToStepStatus(active.status))}</span>
              </div>
              {flow}
              {active.logTail.length > 0
                ? (
                    <details className={css.logs}>
                      <summary>log</summary>
                      <pre className={css.logPre}>{active.logTail.slice(-30).join('\n')}</pre>
                    </details>
                  )
                : null}
            </>
          )
        : null}

      {hasHistory
        ? (
            <section className={css.history}>
              <h3 className={css.historyTitle}>{t('history')}</h3>
              {snapshot?.runs.map(run => (
                <div key={run.runId} className={css.historyRow}>
                  <span className={css.historyRunId}>{run.runId}</span>
                  <span className={css.historyMeta}>
                    {run.module ?? 'auto'} · {run.mode} · {run.changeId ?? ''}
                  </span>
                  <span className={css.historyStatus}>{statusLabel(runStatusToStepStatus(run.status))}</span>
                  <button
                    type="button"
                    className={css.deleteButton}
                    onClick={() => { void ctrl.remove(run.runId) }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </section>
          )
        : null}
    </div>
  )
}

function runStatusToStepStatus(status: string): StepStatus {
  switch (status) {
    case 'running': return 'running'
    case 'waiting_user': return 'waiting_user'
    case 'done': return 'done'
    case 'failed': return 'failed'
    case 'stopped': return 'skipped'
    default: return 'pending'
  }
}

export { SERVER_NS }