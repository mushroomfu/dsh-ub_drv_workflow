/**
 * Launch form for the UB workflow. The module/mode/change-id fields mirror the
 * ub-leader explicit parameters; the requirement text is passed verbatim.
 */

import { useState, type ReactNode } from 'react'
import type { RunMode } from '../core/types.ts'
import type { LaunchPayload } from './api.ts'
import css from './run-launch-form.module.css'

export interface RunLaunchFormProps {
  defaultRepo: string
  sessionId?: string
  labels: {
    formTitle: string
    requirement: string
    requirementPlaceholder: string
    module: string
    moduleAuto: string
    mode: string
    modeDev: string
    modeFull: string
    modeExplore: string
    designOnly: string
    deploy: string
    changeId: string
    start: string
    repoPath: string
  }
  onLaunch: (payload: LaunchPayload) => Promise<void>
}

const MODULES = ['', 'ubase', 'cdma', 'udma', 'ummu', 'ubus'] as const

export function RunLaunchForm(props: RunLaunchFormProps): ReactNode {
  const { labels } = props
  const [repoPath, setRepoPath] = useState(props.defaultRepo)
  const [requirement, setRequirement] = useState('')
  const [module, setModule] = useState('')
  const [mode, setMode] = useState<RunMode>('dev')
  const [designOnly, setDesignOnly] = useState(false)
  const [deploy, setDeploy] = useState(false)
  const [changeId, setChangeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (requirement.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await props.onLaunch({
        repoPath,
        sessionId: props.sessionId,
        requirement: requirement.trim(),
        module: module.trim() || undefined,
        mode,
        designOnly,
        deploy: mode === 'full' && deploy,
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
      <h3 className={css.formTitle}>{labels.formTitle}</h3>

      <label className={css.field}>
        <span>{labels.repoPath}</span>
        <input
          value={repoPath}
          onChange={event => { setRepoPath(event.target.value) }}
          spellCheck={false}
        />
      </label>

      <label className={css.field}>
        <span>{labels.requirement}</span>
        <textarea
          value={requirement}
          onChange={event => { setRequirement(event.target.value) }}
          placeholder={labels.requirementPlaceholder}
          rows={4}
        />
      </label>

      <div className={css.row}>
        <label className={css.field}>
          <span>{labels.module}</span>
          <select value={module} onChange={event => { setModule(event.target.value) }}>
            <option value="">{labels.moduleAuto}</option>
            {MODULES.slice(1).map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>

        <label className={css.field}>
          <span>{labels.mode}</span>
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as RunMode
              setMode(next)
              if (next !== 'full') setDeploy(false)
            }}
          >
            <option value="dev">{labels.modeDev}</option>
            <option value="full">{labels.modeFull}</option>
            <option value="explore">{labels.modeExplore}</option>
          </select>
        </label>

        <label className={css.field}>
          <span>{labels.changeId}</span>
          <input
            value={changeId}
            onChange={event => { setChangeId(event.target.value) }}
            placeholder="module-desc-date"
            spellCheck={false}
          />
        </label>
      </div>

      <div className={css.checks}>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={designOnly}
            onChange={event => {
              setDesignOnly(event.target.checked)
              if (event.target.checked) {
                setMode('dev')
                setDeploy(false)
              }
            }}
          />
          <span>{labels.designOnly}</span>
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={mode === 'full' && deploy}
            disabled={mode !== 'full' || designOnly}
            onChange={event => { setDeploy(event.target.checked) }}
          />
          <span>{labels.deploy}</span>
        </label>
      </div>

      {error !== null
        ? <p className={css.error}>{error}</p>
        : null}

      <button
        type="submit"
        className={css.submit}
        disabled={busy || requirement.trim() === ''}
      >
        {busy ? '…' : labels.start}
      </button>
    </form>
  )
}