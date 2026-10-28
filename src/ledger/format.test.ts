import { describe, expect, test } from 'vitest'
import { formatReport } from './format.js'
import { repair } from './index.js'

describe('formatReport', () => {
  test('a clean document says so in one line', () => {
    const text = formatReport(repair('{"a":1}'))
    expect(text).toContain('verdict: ok')
    expect(text).toContain('loss: none')
    expect(text).toContain('unchanged')
  })

  test('a rejected repair lists the invented value with a path', () => {
    const text = formatReport(repair('[{"id":1},{"id":'))
    expect(text).toContain('verdict: reject')
    expect(text).toContain('invented')
    expect(text).toContain('$[1].id')
    expect(text).toContain('value exists only in the repaired document')
  })

  test('the defect list can be suppressed', () => {
    const withDefects = formatReport(repair('{a:1,}'))
    const without = formatReport(repair('{a:1,}'), { showDefects: false })
    expect(withDefects).toContain('defects (source order)')
    expect(without).not.toContain('defects (source order)')
  })

  test('a refusal is printed verbatim', () => {
    const text = formatReport(repair('{"a":NaN}', { policy: 'safe' }))
    expect(text).toContain('refused:')
  })
})
