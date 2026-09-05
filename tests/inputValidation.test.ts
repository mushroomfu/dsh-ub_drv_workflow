import { describe, expect, it } from 'vitest'
import {
  validateDevelopInputs,
  validateGateBody,
  validateLaunchBody,
  validateRunIdBody,
} from '../src/core/inputValidation.ts'

describe('host API input validation', () => {
  const repoPath = '/configured/repo'

  it('rejects repository overrides', () => {
    const result = validateLaunchBody({ repoPath: '/other/repo', requirement: 'test' }, repoPath)
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('normalizes a valid launch request', () => {
    const result = validateLaunchBody({
      repoPath,
      requirement: '  inspect the call graph  ',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-test-20260904',
    }, repoPath)
    expect(result).toEqual({
      ok: true,
      value: {
        repoPath,
        requirement: 'inspect the call graph',
        module: 'udma',
        mode: 'explore',
        deploy: false,
        designOnly: false,
        changeId: 'udma-test-20260904',
        sessionId: undefined,
      },
    })
  })

  it('rejects a launch requirement above the persisted contract limit', () => {
    expect(validateLaunchBody({
      repoPath,
      requirement: 'x'.repeat(20_001),
      module: 'udma',
      mode: 'explore',
    }, repoPath)).toMatchObject({ ok: false, status: 413 })
  })

  it('fails closed for design, development, and deployment until a host-owned broker exists', () => {
    expect(validateLaunchBody({
      repoPath,
      requirement: 'deploy the driver',
      module: 'udma',
      mode: 'full',
      deploy: true,
    }, repoPath)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/read-only explore|question\/permission broker/i),
    })
    expect(validateLaunchBody({
      repoPath,
      requirement: 'deploy the driver',
      module: 'udma',
      mode: 'dev',
      deploy: false,
    }, repoPath)).toMatchObject({ ok: false })
    expect(validateLaunchBody({
      repoPath,
      requirement: 'design the change',
      module: 'udma',
      mode: 'dev',
      designOnly: true,
    }, repoPath)).toMatchObject({ ok: false })
  })

  it('rejects unknown actions and unsafe identifiers', () => {
    expect(validateGateBody({ runId: '../run', stepId: 'design-gate', action: 'confirm' })).toMatchObject({ ok: false })
    expect(validateGateBody({ runId: 'run-1', stepId: 'made-up', action: 'confirm' })).toMatchObject({ ok: false })
    expect(validateGateBody({ runId: 'run-1', stepId: 'design-gate', action: 'anything' })).toMatchObject({ ok: false })
    expect(validateRunIdBody({ runId: '../run' })).toMatchObject({ ok: false })
  })

  it('accepts design revision only with an instruction', () => {
    expect(validateGateBody({
      runId: 'run-1',
      stepId: 'design-gate',
      action: 'revise',
      response: '重新评估并发关闭路径',
    })).toMatchObject({ ok: true })
    expect(validateGateBody({ runId: 'run-1', stepId: 'review', action: 'revise', response: 'x' }))
      .toMatchObject({ ok: false })
    expect(validateGateBody({ runId: 'run-1', stepId: 'design-gate', action: 'revise' }))
      .toMatchObject({ ok: false })
  })

  it('accepts a bounded clarification response', () => {
    expect(validateGateBody({
      runId: 'run-1',
      stepId: 'requirement-clarify',
      action: 'confirm',
      response: '异常路径也需要释放资源',
    })).toEqual({
      ok: true,
      value: {
        runId: 'run-1',
        stepId: 'requirement-clarify',
        action: 'confirm',
        response: '异常路径也需要释放资源',
      },
    })
  })

  it('validates all upstream develop dispatch inputs as one reviewable block', () => {
    const response = [
      'author: 张三',
      'email: zhangsan@example.com',
      'category: bugfix',
      'max-retries: 0',
      'build-mode: fast',
      'bugzilla: https://atomgit.com/openeuler/kernel/issues/IDXXXX',
      'cve: NA',
      'assisted-by: DSH:DeepSeek',
      'pre-review-strict: false',
    ].join('\n')
    expect(validateDevelopInputs(response)).toMatchObject({ ok: true })
    expect(validateDevelopInputs(response.replace('email: zhangsan@example.com', 'email: invalid')))
      .toMatchObject({ ok: false })
  })

})
