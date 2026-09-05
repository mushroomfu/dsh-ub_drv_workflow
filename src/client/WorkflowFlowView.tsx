import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StepStatus, WorkflowArtifactPreview, WorkflowRun, WorkflowStep } from '../core/types.ts'
import { RunLaunchForm } from './RunLaunchForm.tsx'
import type { UbWorkflowClient } from './api.ts'
import { StepCard, type StepCardProps } from './StepCard.tsx'
import { type UbWorkflowKey } from './locales.ts'
import { useWorkflowRun } from './useWorkflowRun.ts'
import { workflowMetrics } from './workflowMetrics.ts'
import css from './workflow-flow.module.css'

const SERVER_NS = 'ub-workflow'

interface PreviewSnapshot {
  generation: number
  runId: string
  stepId: WorkflowStep['id']
  runUpdatedAt: string
  artifacts: WorkflowArtifactPreview[]
  evidenceIds: string[]
}

export type WorkflowFlowViewProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'ub-workflow'>
  & { workflowClient: UbWorkflowClient }

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

function OrbitMark(): ReactNode {
  return (
    <span className={css.orbitMark} aria-hidden="true">
      <i /><i /><i />
      <b>UB</b>
    </span>
  )
}

function TelemetryLog(props: { run: WorkflowRun; label: string; empty: string }): ReactNode {
  const [open, setOpen] = useState(() => props.run.logTail.length > 0)
  return (
    <details className={css.logs} open={open} onToggle={event => { setOpen(event.currentTarget.open) }}>
      <summary>
        <span><i aria-hidden="true" />{props.label}</span>
        <b>{props.run.logTail.length}</b>
      </summary>
      <pre>{props.run.logTail.length === 0 ? props.empty : props.run.logTail.slice(-30).join('\n')}</pre>
    </details>
  )
}

export function WorkflowFlowView(props: WorkflowFlowViewProps): ReactNode {
  const { t } = props
  const viewIdentityRef = useRef({
    client: props.workflowClient,
    sessionId: props.sessionId,
    generation: 0,
  })
  if (viewIdentityRef.current.client !== props.workflowClient
    || viewIdentityRef.current.sessionId !== props.sessionId) {
    viewIdentityRef.current = {
      client: props.workflowClient,
      sessionId: props.sessionId,
      generation: viewIdentityRef.current.generation + 1,
    }
  }
  const viewGeneration = viewIdentityRef.current.generation
  const ctrl = useWorkflowRun(props.workflowClient, 1500)
  const flowViewportRef = useRef<HTMLDivElement>(null)
  const [busyGate, setBusyGate] = useState<string | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [historyBusy, setHistoryBusy] = useState<string | null>(null)
  const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [historyDetailState, setHistoryDetailState] = useState<{ generation: number; run: WorkflowRun } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewSnapshot, setPreviewSnapshot] = useState<PreviewSnapshot | null>(null)
  const historyRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const historyDetail = historyDetailState?.generation === viewGeneration ? historyDetailState.run : null

  const snapshot = ctrl.snapshot
  const active = snapshot?.activeRun ?? null
  const metrics = active === null ? null : workflowMetrics(active)
  const activeStatus = active === null ? 'pending' : runStatusToStepStatus(active.status)
  const activeVisualStatus = activeStatus === 'waiting_user' ? 'waiting' : activeStatus
  const history = (snapshot?.runs ?? []).filter(run => run.runId !== active?.runId)
  const waitingGate = active?.steps.find(step => step.status === 'waiting_user' && step.gate !== undefined)
  const previewIsCurrent = active !== null && waitingGate !== undefined
    && previewSnapshot?.runId === active.runId
    && previewSnapshot.generation === viewGeneration
    && previewSnapshot.stepId === waitingGate.id
    && previewSnapshot.runUpdatedAt === active.updatedAt
  const artifactPreviews = previewIsCurrent ? previewSnapshot.artifacts : []
  const reviewedEvidenceIds = previewIsCurrent ? previewSnapshot.evidenceIds : []

  useEffect(() => {
    historyRequestRef.current += 1
    previewRequestRef.current += 1
    setHistoryDetailState(null)
    setPreviewSnapshot(null)
    setHistoryBusy(null)
    setDeleteConfirmRunId(null)
    setDeletingRunId(null)
    setBusyGate(null)
    setMutationError(null)
    setPreviewError(null)
  }, [props.sessionId, props.workflowClient])

  useEffect(() => {
    const request = ++previewRequestRef.current
    setPreviewSnapshot(null)
    setPreviewError(null)
    if (active === null || waitingGate === undefined) return
    const runUpdatedAt = active.updatedAt
    void ctrl.previewArtifacts(active.runId, waitingGate.id).then(preview => {
      if (previewRequestRef.current === request) {
        setPreviewError(null)
        setPreviewSnapshot({
          generation: viewGeneration,
          runId: active.runId,
          stepId: waitingGate.id,
          runUpdatedAt,
          artifacts: preview.artifacts,
          evidenceIds: preview.evidenceIds,
        })
      }
    }).catch(error => {
      if (previewRequestRef.current === request) setPreviewError(error instanceof Error ? error.message : t('unknownError'))
    })
  }, [active?.runId, active?.updatedAt, waitingGate?.id, ctrl.previewArtifacts, t, viewGeneration])

  useEffect(() => {
    const viewport = flowViewportRef.current
    if (viewport === null) return

    const centerCurrent = (): void => {
      const current = viewport.querySelector<HTMLElement>('[aria-current="step"]')
      if (current === null) return

      const viewportRect = viewport.getBoundingClientRect()
      const currentRect = current.getBoundingClientRect()
      const contentLeft = currentRect.left - viewportRect.left + viewport.scrollLeft
      const centeredLeft = contentLeft - ((viewport.clientWidth - current.offsetWidth) / 2)
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      viewport.scrollTo({
        left: Math.max(0, centeredLeft),
        behavior: reduceMotion ? 'auto' : 'smooth',
      })
    }

    centerCurrent()
    window.addEventListener('resize', centerCurrent)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(centerCurrent)
    resizeObserver?.observe(viewport)
    return () => {
      window.removeEventListener('resize', centerCurrent)
      resizeObserver?.disconnect()
    }
  }, [active?.runId, metrics?.activeStep?.id])

  const statusLabel = (status: StepStatus): string => t(STATUS_TEXT_KEY[status])
  const cardLabels: Pick<StepCardProps,
    | 'statusLabel'
    | 'userNeededLabel'
    | 'confirmLabel'
    | 'cancelLabel'
    | 'artifactsLabel'
    | 'noArtifactsLabel'
    | 'gateHint'
    | 'gateDoneHint'
    | 'responseLabel'
    | 'responsePlaceholder'
    | 'responseSubmitLabel'
    | 'gateProtocolLabel'
    | 'gateTemplateLabel'
    | 'designProtocolHint'
    | 'deployProtocolHint'
    | 'reviseLabel'
    | 'previewLabel'
    | 'previewTruncatedLabel'
    | 'routeScopeLabel'
    | 'workflowBundleLabel'
    | 'workspaceRootLabel'
    | 'sourceMappingLabel'
  > = {
    statusLabel,
    userNeededLabel: t('userNeeded'),
    confirmLabel: t('confirm'),
    cancelLabel: t('cancel'),
    artifactsLabel: t('artifacts'),
    noArtifactsLabel: t('noArtifacts'),
    gateHint: t('gateConfirmHint'),
    gateDoneHint: t('gateDone'),
    responseLabel: t('clarification'),
    responsePlaceholder: t('clarificationPlaceholder'),
    responseSubmitLabel: t('replyAndContinue'),
    gateProtocolLabel: t('gateProtocol'),
    gateTemplateLabel: t('gateTemplate'),
    designProtocolHint: t('designProtocolHint'),
    deployProtocolHint: t('deployProtocolHint'),
    reviseLabel: t('reviseDesign'),
    previewLabel: t('artifactPreview'),
    previewTruncatedLabel: t('previewTruncated'),
    routeScopeLabel: t('routeScope'),
    workflowBundleLabel: t('workflowBundle'),
    workspaceRootLabel: t('workspaceRoot'),
    sourceMappingLabel: t('sourceMapping'),
  }

  const gate = async (
    runId: string,
    stepId: WorkflowStep['id'],
    action: 'confirm' | 'cancel' | 'revise',
    response?: string,
  ): Promise<void> => {
    const generation = viewGeneration
    const key = `${runId}:${stepId}`
    setBusyGate(key)
    setMutationError(null)
    try {
      const bindsVisibleEvidence = action === 'confirm' && (stepId === 'design-gate' || stepId === 'deploy-ok')
      await ctrl.resolveGate({
        runId,
        stepId,
        action,
        response,
        ...(bindsVisibleEvidence ? { reviewedEvidenceIds } : {}),
      })
    } catch (error) {
      if (viewIdentityRef.current.generation === generation) {
        setMutationError(error instanceof Error ? error.message : t('unknownError'))
      }
    } finally {
      if (viewIdentityRef.current.generation === generation) setBusyGate(null)
    }
  }

  const stop = async (): Promise<void> => {
    if (active === null) return
    const generation = viewGeneration
    setStopBusy(true)
    setMutationError(null)
    try {
      await ctrl.stop(active.runId)
    } catch (error) {
      if (viewIdentityRef.current.generation === generation) {
        setMutationError(error instanceof Error ? error.message : t('unknownError'))
      }
    } finally {
      if (viewIdentityRef.current.generation === generation) setStopBusy(false)
    }
  }

  const remove = async (runId: string): Promise<void> => {
    if (deletingRunId !== null) return
    if (deleteConfirmRunId !== runId) {
      setDeleteConfirmRunId(runId)
      return
    }
    const generation = viewGeneration
    setDeletingRunId(runId)
    setDeleteConfirmRunId(null)
    setMutationError(null)
    try {
      await ctrl.remove(runId)
      if (viewIdentityRef.current.generation === generation && historyDetail?.runId === runId) {
        setHistoryDetailState(null)
      }
    } catch (error) {
      if (viewIdentityRef.current.generation === generation) {
        setMutationError(error instanceof Error ? error.message : t('unknownError'))
      }
    } finally {
      if (viewIdentityRef.current.generation === generation) setDeletingRunId(null)
    }
  }

  const inspectHistory = async (runId: string): Promise<void> => {
    const generation = viewGeneration
    const request = ++historyRequestRef.current
    if (historyDetail?.runId === runId) {
      setHistoryDetailState(null)
      return
    }
    setHistoryBusy(runId)
    setMutationError(null)
    try {
      const run = await ctrl.getRun(runId)
      if (viewIdentityRef.current.generation === generation && historyRequestRef.current === request) {
        setHistoryDetailState({ generation, run })
      }
    } catch (error) {
      if (viewIdentityRef.current.generation === generation && historyRequestRef.current === request) {
        setMutationError(error instanceof Error ? error.message : t('unknownError'))
      }
    } finally {
      if (viewIdentityRef.current.generation === generation && historyRequestRef.current === request) setHistoryBusy(null)
    }
  }

  const flow = active === null
    ? null
    : (
        <div ref={flowViewportRef} className={css.flowViewport}>
          <div className={css.flow} role="list" aria-label={t('pipeline')}>
            {active.steps.map((step, index) => {
              const current = metrics?.currentIndex === index
              const exactCurrent = current && metrics?.activeStep?.id === step.id
              const busyKey = `${active.runId}:${step.id}`
              const requiresEvidenceReview = step.id === 'design-gate' || step.id === 'deploy-ok'
              const confirmDisabled = requiresEvidenceReview && (!previewIsCurrent || reviewedEvidenceIds.length === 0)
              const stepNode = step.id === 'develop' && step.substeps !== undefined && step.substeps.length > 0
                ? (
                    <div className={css.developGroup} role="listitem">
                      <StepCard
                        {...cardLabels}
                        step={step}
                        sequence={index + 1}
                        current={exactCurrent}
                        busy={busyGate === busyKey}
                        confirmDisabled={confirmDisabled}
                        previews={waitingGate?.id === step.id ? artifactPreviews : undefined}
                        onConfirm={(response) => { void gate(active.runId, step.id, 'confirm', response) }}
                        onCancel={() => { void gate(active.runId, step.id, 'cancel') }}
                      />
                      <div className={css.substeps} aria-label={step.title}>
                        {step.substeps.map((sub, subIndex) => (
                          <Fragment key={sub.id}>
                            {subIndex > 0
                              ? <span className={css.miniConnector} data-status={CONNECTOR_STATUS[sub.status]} aria-hidden="true" />
                              : null}
                            <StepCard
                              {...cardLabels}
                              step={sub}
                              compact
                              current={current && metrics?.activeStep?.id === sub.id}
                            />
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )
                : (
                    <div role="listitem">
                      <StepCard
                        {...cardLabels}
                        step={step}
                        sequence={index + 1}
                        current={exactCurrent}
                        busy={busyGate === busyKey}
                        confirmDisabled={confirmDisabled}
                        previews={waitingGate?.id === step.id ? artifactPreviews : undefined}
                        routeScope={step.id === 'routing-plan'
                          && active.workflowPath !== undefined
                          && active.sourceRoots !== undefined
                          ? {
                              workflowPath: active.workflowPath,
                              workspacePath: active.repoPath,
                              sourceRoots: active.sourceRoots,
                            }
                          : undefined}
                        onConfirm={(response) => { void gate(active.runId, step.id, 'confirm', response) }}
                        onRevise={step.id === 'design-gate'
                          ? response => { void gate(active.runId, step.id, 'revise', response) }
                          : undefined}
                        onCancel={() => { void gate(active.runId, step.id, 'cancel') }}
                      />
                    </div>
                  )

              return (
                <Fragment key={step.id}>
                  {index > 0
                    ? (
                        <span className={css.connector} data-status={CONNECTOR_STATUS[step.status]} aria-hidden="true">
                          <i />
                        </span>
                      )
                    : null}
                  {stepNode}
                </Fragment>
              )
            })}
          </div>
        </div>
      )

  return (
    <div className={css.hostFrame}>
      <div className={css.view} data-run-status={activeVisualStatus}>
        <div className={css.ambient} aria-hidden="true"><i /><i /><i /></div>

      <header className={css.topbar}>
        <div className={css.brand}>
          <OrbitMark />
          <div className={css.heading}>
            <span className={css.eyebrow}>{t('eyebrow')}</span>
            <h2 className={css.title}>{t('title')}</h2>
            <p className={css.tagline}>{t('tagline')}</p>
          </div>
        </div>
        <div
          className={css.connection}
          data-online={snapshot !== null && ctrl.error === null}
          role="status"
          aria-live="polite"
          aria-label={snapshot === null || ctrl.error !== null ? t('initializing') : t('connected')}
        >
          <span className={css.connectionDot} aria-hidden="true" />
          <span>{snapshot === null || ctrl.error !== null ? t('initializing') : t('connected')}</span>
        </div>
      </header>

      {ctrl.error !== null || mutationError !== null || previewError !== null
        ? (
            <div className={css.errorBanner} role="alert">
              <span>!</span>
              <p>{ctrl.error !== null ? `${t('refreshFailed')}: ${ctrl.error}` : mutationError ?? previewError}</p>
            </div>
          )
        : null}

      {active !== null && metrics !== null
        ? (
            <>
              <section className={css.missionPanel}>
                <p className={css.srStatus} role="status" aria-live="polite" aria-atomic="true">
                  {statusLabel(activeStatus)} · {metrics.activeStep?.title ?? t('currentStage')}
                  {activeStatus === 'waiting_user' ? ` · ${t('userNeeded')}` : ''}
                </p>
                <div className={css.missionMain}>
                  <div className={css.missionLine}>
                    <span className={css.liveBadge} data-status={activeVisualStatus}>
                      <i aria-hidden="true" />
                      {statusLabel(activeStatus)}
                    </span>
                    <code>{active.changeId ?? active.runId}</code>
                  </div>
                  <h3>{metrics.activeStep?.title ?? t('currentStage')}</h3>
                  <p>{metrics.activeStep?.description ?? active.requirement}</p>
                  <div className={css.progressHeader}>
                    <span>{t('progress')}</span>
                    <strong>{metrics.progressPercent}%</strong>
                  </div>
                  <div
                    className={css.progressTrack}
                    role="progressbar"
                    aria-label={t('progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={metrics.progressPercent}
                  >
                    <span style={{ width: `${metrics.progressPercent}%` }} />
                  </div>
                </div>

                <div className={css.metricGrid}>
                  <article>
                    <span>{t('completed')}</span>
                    <strong>{metrics.completed}<small>/{metrics.total}</small></strong>
                  </article>
                  <article>
                    <span>{t('currentStage')}</span>
                    <strong>{String(metrics.currentIndex + 1).padStart(2, '0')}<small>/{String(metrics.total).padStart(2, '0')}</small></strong>
                  </article>
                  <article>
                    <span>{t('elapsed')}</span>
                    <strong className={css.elapsed}>{metrics.elapsedLabel}</strong>
                  </article>
                </div>

                <button type="button" className={css.stopButton} disabled={stopBusy} onClick={() => { void stop() }}>
                  <span aria-hidden="true" />
                  {stopBusy ? '…' : t('stop')}
                </button>
              </section>

              <section className={css.pipelinePanel}>
                <header className={css.sectionHeader}>
                  <div>
                    <span className={css.sectionKicker}>PIPELINE / {active.mode.toUpperCase()}</span>
                    <h3>{t('pipeline')}</h3>
                    <p>{t('pipelineHint')}</p>
                  </div>
                  <div className={css.legend} aria-label="status legend">
                    {(['running', 'waiting_user', 'done', 'failed'] as const).map(status => (
                      <span key={status} data-status={CONNECTOR_STATUS[status]}><i />{statusLabel(status)}</span>
                    ))}
                  </div>
                </header>
                {flow}
              </section>

              <section className={css.telemetryGrid}>
                <article className={css.signalPanel}>
                  <header>
                    <div>
                      <span className={css.sectionKicker}>EVENT STREAM</span>
                      <h3>{t('latestSignal')}</h3>
                    </div>
                    <span className={css.streamLive}><i /> LIVE</span>
                  </header>
                  <p>{metrics.activeStep?.note ?? active.logTail.at(-1) ?? t('emptyTelemetry')}</p>
                  <div className={css.signalMeta}>
                    <code>{active.runId}</code>
                    <span>{active.module?.toUpperCase() ?? 'AUTO ROUTE'}</span>
                  </div>
                </article>

                <TelemetryLog key={active.runId} run={active} label={t('liveTelemetry')} empty={t('emptyTelemetry')} />
              </section>
            </>
          )
        : snapshot === null
          ? (
              <div className={css.loading} aria-live="polite">
                <OrbitMark />
                <span>{t('initializing')}</span>
              </div>
            )
          : (
              <section className={css.idleLayout}>
                <div className={css.idleIntro}>
                  <span className={css.sectionKicker}>SYSTEM READY</span>
                  <h3>{t('startFirst')}</h3>
                  <p>{t('commandHint')}</p>
                  <code>{t('commandUsage')}</code>
                  <small>{t('commandArgsHint')}</small>
                </div>
                <RunLaunchForm
                  defaultRepo={snapshot.repoPath}
                  sessionId={props.sessionId}
                  labels={{
                    formKicker: t('formKicker'),
                    formTitle: t('formTitle'),
                    launchHint: t('launchHint'),
                    requirement: t('requirement'),
                    requirementPlaceholder: t('requirementPlaceholder'),
                    module: t('module'),
                    moduleAuto: t('moduleAuto'),
                    mode: t('mode'),
                    modeExplore: t('modeExplore'),
                    scopeNotice: t('scopeNotice'),
                    changeId: t('changeId'),
                    start: t('start'),
                    repoPath: t('repoPath'),
                  }}
                  onLaunch={async payload => { void await ctrl.launch(payload) }}
                />
              </section>
            )}

      {history.length > 0
        ? (
            <section className={css.history}>
              <header className={css.sectionHeader}>
                <div>
                  <span className={css.sectionKicker}>RUN ARCHIVE</span>
                  <h3>{t('history')}</h3>
                  <p>{t('historyHint')}</p>
                </div>
                <strong>{String(history.length).padStart(2, '0')}</strong>
              </header>
              <div className={css.historyList}>
                {history.map(run => {
                  const detail = historyDetail?.runId === run.runId ? historyDetail : null
                  const detailStages = detail?.steps.flatMap((step, index) => [
                    { step, sequence: String(index + 1).padStart(2, '0'), depth: 0 },
                    ...(step.substeps ?? []).map((substep, subIndex) => ({
                      step: substep,
                      sequence: `${String(index + 1).padStart(2, '0')}.${subIndex + 1}`,
                      depth: 1,
                    })),
                  ]) ?? []
                  const deepestFirst = [...detailStages].sort((left, right) => right.depth - left.depth)
                  const focusStep = deepestFirst.find(item => item.step.status === 'failed' && item.step.error !== undefined)?.step
                    ?? deepestFirst.find(item => item.step.status === 'failed')?.step
                    ?? [...detailStages].reverse().find(item => item.step.status !== 'pending')?.step
                  return (
                    <article key={run.runId} className={css.historyRow} data-status={CONNECTOR_STATUS[runStatusToStepStatus(run.status)]}>
                      <span className={css.historySignal}><i /></span>
                      <button
                        type="button"
                        className={css.historyIdentity}
                        aria-label={detail === null ? t('viewRunDetails') : t('hideRunDetails')}
                        aria-expanded={detail !== null}
                        disabled={historyBusy === run.runId}
                        onClick={() => { void inspectHistory(run.runId) }}
                      >
                        <strong>{run.changeId ?? run.runId}</strong>
                        <code>{run.runId}</code>
                        <span>{historyBusy === run.runId ? '…' : detail === null ? t('viewRunDetails') : t('hideRunDetails')}</span>
                      </button>
                      <span className={css.historyMeta}>{run.module?.toUpperCase() ?? 'AUTO'} · {run.mode.toUpperCase()}</span>
                      <span className={css.historyStatus}>{statusLabel(runStatusToStepStatus(run.status))}</span>
                      <button
                        type="button"
                        className={css.deleteButton}
                        aria-label={deleteConfirmRunId === run.runId ? t('confirmDeleteRun') : t('deleteRun')}
                        title={deleteConfirmRunId === run.runId ? t('confirmDeleteRun') : t('deleteRun')}
                        data-confirming={deleteConfirmRunId === run.runId || undefined}
                        disabled={deletingRunId !== null}
                        onClick={() => { void remove(run.runId) }}
                      >
                        {deletingRunId === run.runId
                          ? '…'
                          : deleteConfirmRunId === run.runId ? t('confirmDeleteShort') : '×'}
                      </button>
                      {detail !== null
                        ? (
                            <div className={css.historyDetail} role="region" aria-label={t('runDetails')}>
                              <header>
                                <span>{t('runDetails')}</span>
                                <strong>{focusStep?.title ?? statusLabel(runStatusToStepStatus(detail.status))}</strong>
                              </header>
                              <p data-status={CONNECTOR_STATUS[runStatusToStepStatus(detail.status)]}>
                                {focusStep?.error ?? detail.error ?? focusStep?.note ?? t('noRunDetails')}
                              </p>
                              <div className={css.historyStages}>
                                {detailStages.map(item => (
                                  <span
                                    key={item.step.id}
                                    data-depth={item.depth}
                                    data-status={CONNECTOR_STATUS[item.step.status]}
                                  >
                                    <b>{item.sequence}</b>
                                    {item.step.title}
                                    <i>{statusLabel(item.step.status)}</i>
                                  </span>
                                ))}
                              </div>
                              {detail.logTail.length > 0 ? <pre>{detail.logTail.slice(-12).join('\n')}</pre> : null}
                            </div>
                          )
                        : null}
                    </article>
                  )
                })}
              </div>
            </section>
          )
        : null}
      </div>
    </div>
  )
}

export { SERVER_NS }
