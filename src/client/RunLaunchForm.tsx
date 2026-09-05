import { useState, type ReactNode } from 'react'
import type { LaunchPayload } from './api.ts'
import css from './run-launch-form.module.css'

export interface RunLaunchFormProps {
  defaultRepo: string
  sessionId?: string
  labels: {
    formKicker: string
    formTitle: string
    requirement: string
    requirementPlaceholder: string
    module: string
    moduleAuto: string
    mode: string
    modeExplore: string
    scopeNotice: string
    changeId: string
    start: string
    repoPath: string
  }
  onLaunch: (payload: LaunchPayload) => Promise<void>
}

const MODULES = ['', 'ubase', 'cdma', 'udma', 'ummu', 'ubus'] as const

export function RunLaunchForm(props: RunLaunchFormProps): ReactNode {
  const { labels } = props
  const [requirement, setRequirement] = useState('')
  const [module, setModule] = useState('')
  const [changeId, setChangeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (requirement.trim() === '' || module === '') return
    setBusy(true)
    setError(null)
    try {
      await props.onLaunch({
        sessionId: props.sessionId,
        requirement: requirement.trim(),
        module,
        mode: 'explore',
        designOnly: false,
        deploy: false,
        changeId: changeId.trim() || undefined,
      })
      setRequirement('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknownError')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={css.form}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <header className={css.formHeader}>
        <div>
          <span className={css.kicker}>{labels.formKicker}</span>
          <h3 className={css.formTitle}>{labels.formTitle}</h3>
        </div>
        <span className={css.readyBeacon} aria-hidden="true"><i /></span>
      </header>

      <div className={css.repoStrip}>
        <span>{labels.repoPath}</span>
        <code title={props.defaultRepo}>{props.defaultRepo}</code>
      </div>

      <label className={[css.field, css.requirementField].join(' ')}>
        <span>{labels.requirement}</span>
        <textarea
          value={requirement}
          onChange={event => { setRequirement(event.target.value) }}
          placeholder={labels.requirementPlaceholder}
          rows={5}
          maxLength={20_000}
        />
        <small>{requirement.length.toLocaleString()} / 20,000</small>
      </label>

      <div className={css.row}>
        <label className={css.field}>
          <span>{labels.module}</span>
          <select value={module} onChange={event => { setModule(event.target.value) }}>
            <option value="">{labels.moduleAuto}</option>
            {MODULES.slice(1).map(id => <option key={id} value={id}>{id.toUpperCase()}</option>)}
          </select>
        </label>

        <div className={css.field}>
          <span>{labels.mode}</span>
          <div className={css.lockedMode}><i aria-hidden="true" />{labels.modeExplore}</div>
        </div>

        <label className={css.field}>
          <span>{labels.changeId}</span>
          <input
            value={changeId}
            onChange={event => { setChangeId(event.target.value.replace(/[^A-Za-z0-9._-]/g, '')) }}
            placeholder="module-desc-date"
            maxLength={128}
            spellCheck={false}
          />
        </label>
      </div>

      <div className={css.checks}>
        <p className={css.safetyNotice}>{labels.scopeNotice}</p>
      </div>

      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}

      <div className={css.submitRow}>
        <span className={css.submitLine} aria-hidden="true" />
        <button
          type="submit"
          className={css.submit}
          disabled={busy || requirement.trim() === '' || module === ''}
        >
          <span>{busy ? 'INITIALIZING…' : labels.start}</span>
          <b aria-hidden="true">↗</b>
        </button>
      </div>
    </form>
  )
}
