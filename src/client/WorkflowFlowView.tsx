/**
 * The session view registered into `conversation.view`: a horizontal flow of
 * step cards connected by status-colored lines. Starting a workflow happens
 * from the conversation composer via the `/ub-workflow` slash command; this
 * view is the live monitoring surface plus gate-confirmation controls.
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { StepStatus, WorkflowRun, WorkflowStep } from '../core/types.ts'
import { allSteps } from '../core/stages.ts'
import { ubWorkflowClient } from './api.ts'
import { useWorkflowRun } from './useWorkflowRun.ts'
import { StepCard } from './StepCard.tsx'
import { type UbWorkflowKey } from './locales.ts'
import css from './workflow-flow.module.css'

const SERVER_NS = 'ub-workflow'

export type WorkflowFlowViewProps = {
  /** Current conversation session id used to scope the displayed runs. */
  sessionId: string
  /** Namespace-bound locale function supplied by the hosting component. */
  t: (key: UbWorkflowKey) => string
}

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
  const { t, sessionId } = props
  const ctrl = useWorkflowRun(1500)
  const [busyGate, setBusyGate] = useState<string | null>(null)

  const snapshot = ctrl.snapshot
  const rawActive = snapshot?.activeRun ?? null
  const activeForSession = rawActive !== null && (rawActive.sessionId === undefined || rawActive.sessionId === sessionId)
    ? rawActive
    : null
  // Session-scoped history only. Legacy runs without a sessionId belong to
  // conversations created before session binding existed — showing them in
  // EVERY session's drawer made unrelated old stopped runs (e.g. "用户终止")
  // appear as this conversation's progress. They are only used as a fallback
  // when this session has no runs of its own.
  const ownRuns = (snapshot?.runs ?? []).filter(run => run.sessionId === sessionId)
  const legacyRuns = (snapshot?.runs ?? []).filter(run => run.sessionId === undefined)
  const sessionSummaries = ownRuns.length > 0 ? ownRuns : legacyRuns
  const [fallbackRun, setFallbackRun] = useState<WorkflowRun | null>(null)

  const latestSummaryRunId = sessionSummaries[0]?.runId
  useEffect(() => {
    if (activeForSession !== null) {
      setFallbackRun(null)
      return
    }
    if (latestSummaryRunId === undefined) {
      setFallbackRun(null)
      return
    }
    let alive = true
    setFallbackRun(null)
    void ubWorkflowClient.run(latestSummaryRunId)
      .then(({ run }) => { if (alive) setFallbackRun(run) })
      .catch(() => { if (alive) setFallbackRun(null) })
    return () => { alive = false }
  }, [activeForSession, latestSummaryRunId, sessionId])

  // Keep the last workflow visible after the conversation/run is terminated,
  // so the current step position stays on screen with the stop annotation.
  const active = activeForSession ?? fallbackRun
  const [historyOpen, setHistoryOpen] = useState(false)

  const progress = useMemo(() => {
    if (active === null) return { done: 0, total: 0, pct: 0 }
    const steps = allSteps(active.steps)
    const done = steps.filter(step => step.status === 'done').length
    const total = steps.length
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
  }, [active])

  const statusLabel = (status: StepStatus): string => t(STATUS_TEXT_KEY[status])

  const gate = async (runId: string, stepId: WorkflowStep['id'], action: 'confirm' | 'cancel'): Promise<void> => {
    setBusyGate(runId)
    try {
      await ctrl.resolveGate({ runId, stepId, action })
    } finally {
      setBusyGate(null)
    }
  }

  const hasHistory = sessionSummaries.length > 0

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
                    stepNo={index + 1}
                    statusLabel={statusLabel}
                    userNeededLabel={t('userNeeded')}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    artifactsLabel={t('artifacts')}
                    noArtifactsLabel={t('noArtifacts')}
                    gateHint={t('gateConfirmHint')}
                    gateDoneHint={t('gateDone')}
                    resultLabel={t('resultLabel')}
                    outputDirLabel={t('outputDirLabel')}
                    writebackLabel={t('writebackLabel')}
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
                  stepNo={index + 1}
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
                <span className={css.runStatus}>{active.status === 'stopped' ? t('runStopped') : statusLabel(runStatusToStepStatus(active.status))}</span>
              </div>

              {active.status === 'stopped'
                ? <div className={css.stoppedNotice}>{active.error ?? '用户终止'}</div>
                : null}

              <div className={css.progressBlock}>
                <div className={css.progressTrack}>
                  <div
                    className={css.progressFill}
                    style={{ width: `${progress.pct}%` }}
                  />
                </div>
                <div className={css.progressMeta}>
                  <span>{progress.done}/{progress.total}</span>
                  <span className={css.progressPercent}>{progress.pct}%</span>
                </div>
              </div>

              {flow}
            </>
          )
        : null}

      {hasHistory
        ? (
            <section className={css.history}>
              <button
                type="button"
                className={css.historyToggle}
                onClick={() => { setHistoryOpen(value => !value) }}
              >
                <span className={css.historyCaret} aria-hidden="true">{historyOpen ? '▾' : '▸'}</span>
                {t('history')}
              </button>
              {historyOpen
                ? (
                    <div className={css.historyPanel}>
                      {sessionSummaries.map(run => (
                        <div key={run.runId} className={css.historyRow}>
                          <span className={css.historyRunId}>{run.runId}</span>
                          <span className={css.historyMeta}>
                            {run.module ?? 'auto'} · {run.mode} · {run.changeId ?? ''}
                          </span>
                          <span className={css.historyStatus}>{run.status === 'stopped' ? t('runStopped') : statusLabel(runStatusToStepStatus(run.status))}</span>
                          <button
                            type="button"
                            className={css.deleteButton}
                            onClick={() => { void ctrl.remove(run.runId) }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                : null}
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