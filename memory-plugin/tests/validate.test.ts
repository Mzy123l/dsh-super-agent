// 收割校验测试：验证三道校验能抓住串位。

import { describe, expect, it } from 'vitest'
import {
  validateSummary,
  termOverlap,
  extractTerms,
  startsWithProcessOpener,
  SUMMARY_MAX_RATIO,
  SUMMARY_MIN_OVERLAP,
} from '../src/summary/validate.js'

describe('实词抽取', () => {
  it('英文标识符', () => {
    const t = extractTerms('memory-plugin source code structure')
    expect(t).toContain('memory-plugin')
    expect(t).toContain('source')
    expect(t).toContain('structure')
  })

  it('过滤停用词', () => {
    const t = extractTerms('the tool call name bash result error')
    expect(t).not.toContain('the')
    expect(t).not.toContain('tool')
    expect(t).not.toContain('bash')
  })

  it('中文双字词', () => {
    const t = extractTerms('换行符统一')
    expect(t.length).toBeGreaterThan(0)
    expect(t.some(x => x.includes('换行'))).toBe(true)
  })
})

describe('实词重合', () => {
  const content = `
<tool-call name="bash">
{"command":"cd /mnt/c/Users/Assistant/projects/dsh-super-agent && git status"}
</tool-call>
<tool-result isError="false">
On branch main
Changes not staged for commit:
  modified: memory-plugin/src/summary/pending.ts
  modified: memory-plugin/src/dsh-bundle.ts
</tool-result>`

  it('正确提炼有足够重合', () => {
    const good = 'git status 显示 memory-plugin 下两个文件被修改：summary/pending.ts 与 dsh-bundle.ts'
    expect(termOverlap(good, content)).toBeGreaterThan(SUMMARY_MIN_OVERLAP)
  })

  it('串位的摘要零重合（#8 真实案例）', () => {
    const wrong = 'diff 从 2103 行降到 456 行，纯换行带来的噪声已清零。现在重装验证'
    expect(termOverlap(wrong, content)).toBeLessThan(SUMMARY_MIN_OVERLAP)
  })

  it('原文无实词时不误杀', () => {
    expect(termOverlap('任意内容', '。。。！')).toBe(1)
  })
})

describe('过程性开场识别', () => {
  it('中文过程性开场', () => {
    expect(startsWithProcessOpener('我先查一下这几个文件')).toBe(true)
    expect(startsWithProcessOpener('现在把 summaryInFlight 接入')).toBe(true)
    expect(startsWithProcessOpener('开始改三档阈值')).toBe(true)
    expect(startsWithProcessOpener('让我先看源码')).toBe(true)
  })

  it('英文过程性开场', () => {
    expect(startsWithProcessOpener('Let me check the source')).toBe(true)
    expect(startsWithProcessOpener('The task: condense unit #11')).toBe(true)
    expect(startsWithProcessOpener('I should read the file first')).toBe(true)
  })

  it('正常提炼不算过程性', () => {
    expect(startsWithProcessOpener('否决了改前端，因为根因在后端')).toBe(false)
    expect(startsWithProcessOpener('确认 ttl=300 秒，偏短')).toBe(false)
  })
})

describe('validateSummary 三道校验', () => {
  // 真实场景：提炼只对 ≥4000 字符的长单位触发，所以原文要够长
  const content = (
    '这是一个很长的原文，讨论了 memory-plugin 的 source structure 和 dsh-bundle 的实现细节，'
    + '最终决定把 summary 挂接逻辑改到 validate 模块里，并且保留 pending 以便重试。'
    + '该模块负责校验摘要与原文的实词重合度、过程性开场和长度比例。'
    + '同时确认了 projection 层不能直接改 dsh-bundle 的写入路径，因为会和 surface replace 冲突。'
  ).repeat(8)

  it('合法提炼通过', () => {
    const good = '决定把 summary 挂接逻辑改到 validate 模块；保留 pending 以便重试。' +
      '否决了直接改 dsh-bundle 的方案，因为会和 projection 逻辑混在一起。'
    const r = validateSummary(good, content)
    expect(r.ok).toBe(true)
  })

  it('过程性开场被拒（retryable）', () => {
    const r = validateSummary('我先查一下 validate 模块的现有实现', content)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('过程性')
    expect(r.retryable).toBe(true)
  })

  it('长度超限被拒', () => {
    const tooLong = content.slice(0, Math.floor(content.length * 0.8))
    const r = validateSummary(tooLong, content)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('未收敛')
  })

  it('零重合被拒（串位）', () => {
    const r = validateSummary('完全不相干的内容，讲的是数据库索引优化和缓存穿透', content)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('串位')
  })

  it('空回复被拒', () => {
    const r = validateSummary('   ', content)
    expect(r.ok).toBe(false)
  })
})

describe('真实串位案例回归', () => {
  it('#8：find 命令的摘要错挂成 diff 汇报', () => {
    const content = `<tool-call name="bash">
{"command":"find /mnt/c/Users/Assistant/projects/dsh-super-agent -maxdepth 3 -iname '*memory*'"}
</tool-call>
<tool-result isError="false">
/mnt/c/Users/Assistant/projects/dsh-super-agent/memory-plugin
/mnt/c/Users/Assistant/projects/dsh-super-agent/memory-debug-capture
/mnt/c/Users/Assistant/projects/dsh-super-agent/tools
</tool-result>`
    const wrongSummary = 'diff 从 2103 行降到 456 行，纯换行带来的噪声已清零。现在重装验证换行符改动没有影响运行，并重跑测试：'
    const r = validateSummary(wrongSummary, content)
    expect(r.ok).toBe(false)
  })

  it('#14：git status 的摘要错挂成提交汇报', () => {
    const content = `<tool-call name="bash">
{"command":"cd /mnt/c/Users/Assistant/projects/dsh-super-agent && git status"}
</tool-call>
<tool-result isError="false">
On branch main
nothing to commit, working tree clean
</tool-result>`
    const wrongSummary = '已提交 1c92c82，只含 9 个真实改动文件。注意：状态里仍显示 7 个 M 文件'
    const r = validateSummary(wrongSummary, content)
    expect(r.ok).toBe(false)
  })
})
