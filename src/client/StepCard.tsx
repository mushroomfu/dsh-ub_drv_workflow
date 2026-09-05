import { useState, type ReactNode } from 'react'
import type { StepStatus, WorkflowArtifactPreview, WorkflowSourceRoot, WorkflowStep } from '../core/types.ts'
import css from './step-card.module.css'

export interface StepCardProps {
  step: WorkflowStep
  statusLabel: (status: StepStatus) => string
  userNeededLabel: string
  confirmLabel: string
  cancelLabel: string
  artifactsLabel: string
  noArtifactsLabel: string
  gateHint: string
  gateDoneHint: string
  responseLabel: string
  responsePlaceholder: string
  responseSubmitLabel: string
  gateProtocolLabel: string
  gateTemplateLabel: string
  designProtocolHint: string
  deployProtocolHint: string
  reviseLabel: string
  previewLabel: string
  previewTruncatedLabel: string
  routeScopeLabel: string
  workflowBundleLabel: string
  workspaceRootLabel: string
  sourceMappingLabel: string
  sequence?: number
  busy?: boolean
  confirmDisabled?: boolean
  compact?: boolean
  current?: boolean
  onConfirm?: (response?: string) => void
  onRevise?: (response: string) => void
  onCancel?: () => void
  previews?: WorkflowArtifactPreview[]
  routeScope?: {
    workflowPath: string
    workspacePath: string
    sourceRoots: WorkflowSourceRoot[]
  }
}

function timeOnly(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function StepCard(props: StepCardProps): ReactNode {
  const { step, busy = false, confirmDisabled = false, compact = false, current = false } = props
  const [response, setResponse] = useState('')
  const visualStatus = step.status === 'waiting_user' ? 'waiting' : step.status
  const needsResponse = step.interaction === 'response'
  const showsResponse = needsResponse || props.onRevise !== undefined
  const protocol = needsResponse && step.id === 'design-gate'
    ? {
        hint: props.designProtocolHint,
        template: [
          'author: <真实姓名>',
          'email: <邮箱>',
          'category: feature',
          'max-retries: 2',
          'build-mode: fast',
          'bugzilla: <URL>',
          'cve: NA',
          'assisted-by: DeepSeek Harness',
          'pre-review-strict: true',
        ].join('\n'),
      }
    : needsResponse && step.id === 'deploy-authorize'
      ? {
          hint: props.deployProtocolHint,
          template: [
            'deploy-target-ip: <IPv4/IPv6>',
            'verify-modules: <module.ko,module2.ko>',
            'stc: true',
            'live-deployment-authorized: true',
          ].join('\n'),
        }
      : undefined
  const started = timeOnly(step.startedAt)
  const finished = timeOnly(step.finishedAt)

  return (
    <section
      className={[
        css.card,
        compact ? css.compact : '',
        current ? css.current : '',
        css[`status-${visualStatus}`],
      ].filter(Boolean).join(' ')}
      data-status={visualStatus}
      aria-current={current ? 'step' : undefined}
    >
      <span className={css.scanline} aria-hidden="true" />
      <header className={css.header}>
        <div className={css.identity}>
          {props.sequence !== undefined
            ? <span className={css.sequence}>{String(props.sequence).padStart(2, '0')}</span>
            : null}
          <span className={css.title}>{step.title}</span>
        </div>
        <span className={css.signal} data-status={visualStatus} aria-hidden="true" />
      </header>

      {!compact ? <p className={css.description}>{step.description}</p> : null}

      <div className={css.meta}>
        <span className={[css.badge, css[`badge-${visualStatus}`]].join(' ')}>
          <span className={css.badgeDot} aria-hidden="true" />
          {props.statusLabel(step.status)}
        </span>
        {step.needsUser
          ? <span className={css.userBadge}>{props.userNeededLabel}</span>
          : null}
        {!compact && started !== undefined
          ? <span className={css.time}>{started}{finished === undefined ? '' : ` — ${finished}`}</span>
          : null}
      </div>

      {!compact && step.note !== undefined && step.note !== ''
        ? (
            <div className={css.noteBlock}>
              <span className={css.noteLabel}>SIGNAL</span>
              <p className={css.note}>{step.note}</p>
            </div>
          )
        : null}

      {!compact && step.id === 'routing-plan' && props.routeScope !== undefined
        ? (
            <div className={css.scopeReview} aria-label={props.routeScopeLabel}>
              <span className={css.scopeTitle}>{props.routeScopeLabel}</span>
              <dl>
                <div>
                  <dt>{props.workflowBundleLabel}</dt>
                  <dd><code title={props.routeScope.workflowPath}>{props.routeScope.workflowPath}</code></dd>
                </div>
                <div>
                  <dt>{props.workspaceRootLabel}</dt>
                  <dd><code title={props.routeScope.workspacePath}>{props.routeScope.workspacePath}</code></dd>
                </div>
                {props.routeScope.sourceRoots.map(root => (
                  <div key={root.manifestPath}>
                    <dt>{props.sourceMappingLabel} · <code>{root.manifestPath}</code></dt>
                    <dd><code title={root.path}>{root.path}</code></dd>
                  </div>
                ))}
              </dl>
            </div>
          )
        : null}

      {!compact && step.error !== undefined && step.error !== ''
        ? <p className={css.error}>{step.error}</p>
        : null}

      {!compact
        ? (
            <div className={css.artifacts}>
              <span className={css.artifactsLabel}>{props.artifactsLabel}</span>
              {step.artifactHints.length === 0
                ? <span className={css.noArtifacts}>{props.noArtifactsLabel}</span>
                : (
                    <div className={css.artifactList}>
                      {step.artifactHints.map(hint => <code key={hint}>{hint}</code>)}
                    </div>
                  )}
            </div>
          )
        : null}

      {!compact && (props.previews?.length ?? 0) > 0
        ? (
            <div className={css.previews}>
              <span className={css.artifactsLabel}>{props.previewLabel}</span>
              {props.previews?.map(preview => (
                <details key={preview.path}>
                  <summary><code>{preview.path}</code><small>{preview.size} B</small></summary>
                  <pre>{preview.content}{preview.truncated ? `\n\n… ${props.previewTruncatedLabel}` : ''}</pre>
                </details>
              ))}
            </div>
          )
        : null}

      {!compact && step.needsUser && step.status === 'done'
        ? <div className={css.gateComplete}>✓ {props.gateDoneHint}</div>
        : null}

      {step.status === 'waiting_user'
        ? (
            <footer className={css.gateBar}>
              <div className={css.gateHeader}>
                <span className={css.gatePulse} aria-hidden="true" />
                <p className={css.gateHint}>{props.gateHint}</p>
              </div>
              {showsResponse
                ? (
                    <>
                      {protocol === undefined
                        ? null
                        : (
                            <div className={css.protocolGuide}>
                              <span>{props.gateProtocolLabel}</span>
                              <p>{protocol.hint}</p>
                              <button type="button" disabled={busy} onClick={() => { setResponse(protocol.template) }}>
                                {props.gateTemplateLabel}
                              </button>
                            </div>
                          )}
                      <label className={css.responseField}>
                        <span>{protocol === undefined ? props.responseLabel : props.gateProtocolLabel}</span>
                        <textarea
                          rows={protocol === undefined ? 3 : step.id === 'design-gate' ? 11 : 6}
                          value={response}
                          placeholder={protocol?.template ?? props.responsePlaceholder}
                          disabled={busy}
                          onChange={event => { setResponse(event.target.value) }}
                        />
                      </label>
                    </>
                  )
                : null}
              <div className={css.gateActions}>
                <button
                  type="button"
                  className={css.confirmButton}
                  disabled={busy || confirmDisabled || (needsResponse && response.trim() === '')}
                  onClick={() => { props.onConfirm?.(needsResponse ? response.trim() : undefined) }}
                >
                  {busy ? '…' : needsResponse ? props.responseSubmitLabel : props.confirmLabel}
                </button>
                {props.onRevise !== undefined
                  ? (
                      <button
                        type="button"
                        className={css.reviseButton}
                        disabled={busy || response.trim() === ''}
                        onClick={() => { props.onRevise?.(response.trim()) }}
                      >
                        {props.reviseLabel}
                      </button>
                    )
                  : null}
                <button
                  type="button"
                  className={css.cancelButton}
                  disabled={busy}
                  onClick={() => { props.onCancel?.() }}
                >
                  {props.cancelLabel}
                </button>
              </div>
            </footer>
          )
        : null}
    </section>
  )
}
