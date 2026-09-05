import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import { StepCard } from '../src/client/StepCard.tsx'

const labels = {
  statusLabel: () => '等待用户',
  userNeededLabel: '需要用户接入',
  confirmLabel: '确认',
  cancelLabel: '取消',
  artifactsLabel: '产物证据',
  noArtifactsLabel: '无需文件',
  gateHint: '请确认',
  gateDoneHint: '已确认',
  responseLabel: '澄清回复',
  responsePlaceholder: '请输入回答',
  responseSubmitLabel: '发送并继续',
  gateProtocolLabel: '门禁参数协议',
  gateTemplateLabel: '填入字段模板',
  designProtocolHint: '设计参数规则',
  deployProtocolHint: '部署参数规则',
  reviseLabel: '重新设计',
  previewLabel: '证据预览',
  previewTruncatedLabel: '已截断',
  routeScopeLabel: '确认读取范围',
  workflowBundleLabel: '工作流包',
  workspaceRootLabel: '工作区根目录',
  sourceMappingLabel: '源码映射',
}

describe('StepCard', () => {
  it('renders an accessible response control for requirement clarification', () => {
    const step = buildStageChain({ mode: 'dev' }).find(item => item.id === 'requirement-clarify')
    expect(step).toBeDefined()
    if (step === undefined) return
    step.status = 'waiting_user'

    const html = renderToStaticMarkup(
      <StepCard {...labels} step={step} sequence={3} current />,
    )
    expect(html).toContain('textarea')
    expect(html).toContain('澄清回复')
    expect(html).toContain('发送并继续')
    expect(html).toContain('aria-current="step"')
  })

  it('keeps design revision available in a design-only confirmation gate', () => {
    const step = buildStageChain({ mode: 'dev', designOnly: true }).find(item => item.id === 'design-gate')
    expect(step).toBeDefined()
    if (step === undefined) return
    step.status = 'waiting_user'

    const html = renderToStaticMarkup(
      <StepCard {...labels} step={step} onRevise={() => {}} />,
    )
    expect(html).toContain('textarea')
    expect(html).toContain('重新设计')
  })

  it('shows the exact structured protocol required by a development gate', () => {
    const step = buildStageChain({ mode: 'dev', testTimings: ['post-dev'] }).find(item => item.id === 'design-gate')
    expect(step).toBeDefined()
    if (step === undefined) return
    step.status = 'waiting_user'

    const html = renderToStaticMarkup(<StepCard {...labels} step={step} />)
    expect(html).toContain('填入字段模板')
    expect(html).toContain('author: &lt;真实姓名&gt;')
    expect(html).toContain('pre-review-strict: true')
    expect(html).toContain('设计参数规则')
  })

  it('renders every reviewed UMMU source path in full at the routing gate', () => {
    const step = buildStageChain({ mode: 'explore' }).find(item => item.id === 'routing-plan')
    expect(step).toBeDefined()
    if (step === undefined) return
    step.status = 'waiting_user'
    const library = '/Users/developer/Documents/openeuler_work/user_rep/libummu'
    const kernel = '/Users/developer/Documents/openeuler_work/kernel_atom/kernel/drivers/iommu/hisilicon'

    const html = renderToStaticMarkup(<StepCard
      {...labels}
      step={step}
      routeScope={{
        workflowPath: '/Users/developer/Documents/ai_work/ub-drv-develop',
        workspacePath: '/Users/developer/Documents/ai_work',
        sourceRoots: [
          { manifestPath: 'libummu', path: library },
          { manifestPath: 'drivers/iommu/hisilicon', path: kernel },
        ],
      }}
    />)

    expect(html).toContain('aria-label="确认读取范围"')
    expect(html).toContain('libummu')
    expect(html).toContain(library)
    expect(html).toContain('drivers/iommu/hisilicon')
    expect(html).toContain(kernel)
  })
})
