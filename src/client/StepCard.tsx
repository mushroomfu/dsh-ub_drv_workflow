/**
 * One workflow step card: status badge, title, times, artifact hints, and the
 * gate action bar when the step is waiting for the user.
 */

import type { ReactNode } from 'react'
import type { StepStatus, WorkflowStep } from '../core/types.ts'
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
  busy?: boolean
  compact?: boolean
  onConfirm?: () => void
  onCancel?: () => void
}

export function StepCard(props: StepCardProps): ReactNode {
  const { step, busy = false, compact = false } = props

  return (
    <section className={[css.card, compact ? css.compact : '', css[`status-${step.status === 'waiting_user' ? 'waiting' : step.status}`]].join(' ')}>
      <header className={css.header}>
        <span className={css.title}>{step.title}</span>
        {step.needsUser
          ? (
              <span className={css.userBadge} title={props.userNeededLabel}>
                {props.userNeededLabel}
              </span>
            )
          : null}
      </header>

      {!compact
        ? <p className={css.description}>{step.description}</p>
        : null}

      <div className={css.meta}>
        <span className={[css.badge, css[`badge-${step.status === 'waiting_user' ? 'waiting' : step.status}`]].join(' ')}>
          {props.statusLabel(step.status)}
        </span>
        {!compact && step.startedAt !== undefined
          ? <span className={css.time}>{step.startedAt}</span>
          : null}
        {!compact && step.finishedAt !== undefined
          ? <span className={css.time}>→ {step.finishedAt}</span>
          : null}
      </div>

      {!compact && step.note !== undefined && step.note !== ''
        ? <p className={css.note}>{step.note}</p>
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
                    <ul className={css.artifactList}>
                      {step.artifactHints.map(hint => <li key={hint}>{hint}</li>)}
                    </ul>
                  )}
            </div>
          )
        : null}

      {step.status === 'waiting_user'
        ? (
            <footer className={css.gateBar}>
              <p className={css.gateHint}>{props.gateHint}</p>
              <div className={css.gateActions}>
                <button
                  type="button"
                  className={css.confirmButton}
                  disabled={busy}
                  onClick={() => { props.onConfirm?.() }}
                >
                  {props.confirmLabel}
                </button>
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