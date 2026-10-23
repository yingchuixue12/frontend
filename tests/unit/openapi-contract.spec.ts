import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 消费侧契约门禁：
//   1) vendor 进来的 OpenAPI 规格必须与 sha256 对账文件一致（防止就地篡改）；
//   2) 生成物 src/api/generated/openapi.d.ts 必须覆盖调用点用到的全部端点；
//   3) 前端实际调用的端点必须出现在契约里（调用点与契约不得各说各话）；
//   4) 「所有调用点都走契约门面」必须是机器判定：登记表 ↔ 代码里的 apiX(...) 双向一致，
//      且除门面外不得再出现直连 axios / 未登记的契约路径字面量。

const root = process.cwd()
const specPath = resolve(root, 'openapi/drone-backend.openapi.json')
const shaPath = resolve(root, 'openapi/drone-backend.openapi.sha256')
const generatedPath = resolve(root, 'src/api/generated/openapi.d.ts')
const srcDir = resolve(root, 'src')

/** 前端调用点触及的端点（与 src/api/modules 一一对应；新增调用点必须同步登记） */
const CALLED_OPERATIONS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['post', '/user/refresh'],
  ['post', '/admin/login'],
  ['get', '/admin/uav'],
  ['get', '/admin/uav/live'],
  ['get', '/admin/uav/statistics'],
  ['post', '/admin/uav/available'],
  ['get', '/admin/logs/application'],
  ['get', '/admin/logs/error'],
  ['get', '/admin/logs/files'],
  ['get', '/admin/logs/read'],
  ['get', '/admin/orders'],
  ['get', '/admin/orders/{orderNum}'],
  ['get', '/admin/tasks'],
  ['get', '/admin/tasks/{taskNum}'],
  ['get', '/admin/complaint/list'],
  ['post', '/admin/complaint/{id}/approve'],
  ['post', '/admin/complaint/{id}/reject'],
  ['get', '/webUav/getUav'],
  ['get', '/webUav/status'],
  ['get', '/webUav/position'],
  ['get', '/webUav/trajectory'],
  ['get', '/rider/recommended'],
  ['post', '/live/req'],
  ['post', '/live/get'],
  ['post', '/live/close'],
  ['post', '/live/leave'],
  ['get', '/task/detail'],
  ['get', '/task/{taskNum}/applications'],
  ['get', '/tasks/{taskNum}/attachments'],
  ['get', '/admin/users'],
  ['get', '/admin/users/{userId}'],
  ['get', '/admin/pilots'],
  ['get', '/admin/pilots/{userId}'],
]

/** 门面自身与其运行时底座：这两个文件允许出现路径字面量与 axios 实例调用 */
const FACADE_FILES = new Set(['api/contract.ts', 'api/request.ts'])

const walk = (dir: string, prefix = ''): string[] => {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      files.push(...walk(resolve(dir, entry.name), rel))
    } else if (/\.(ts|vue)$/.test(entry.name)) {
      files.push(rel)
    }
  }
  return files
}

const sourceFiles = walk(srcDir).filter((rel) => !rel.startsWith('api/generated/'))
const readSource = (rel: string) => readFileSync(resolve(srcDir, rel), 'utf8')

/** 代码里真正发起的契约调用：apiGet('/x', …) / apiPost('/x', …) … */
const CALL_RE = /\bapi(Get|Post|Put|Delete)\s*(?:<[^>]*>)?\(\s*'([^']+)'/g

/** 门面运行时里允许直连 axios 的调用：401 单飞刷新必须绕过拦截器，否则会递归刷新 */
const RAW_CALL_RE = /\brawRequest\.(get|post|put|delete)\s*(?:<[^>]*>)?\(\s*'([^']+)'/g

const collectCallSites = (): Array<[string, string, string]> => {
  const found: Array<[string, string, string]> = []
  for (const rel of sourceFiles) {
    const text = readSource(rel)
    for (const match of text.matchAll(CALL_RE)) {
      found.push([match[1].toLowerCase(), match[2], rel])
    }
    if (rel === 'api/request.ts') {
      for (const match of text.matchAll(RAW_CALL_RE)) {
        found.push([match[1].toLowerCase(), match[2], rel])
      }
    }
  }
  return found
}

const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  paths: Record<string, Record<string, unknown>>
}

describe('OpenAPI 契约（消费侧门禁）', () => {
  it('契约采用 LF 换行，与跨平台 checkout 及同步脚本一致', () => {
    expect(readFileSync(specPath, 'utf8')).not.toContain('\r')
  })
  it('vendor 契约与 sha256 对账文件一致', () => {
    const shaFile = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0]
    const actual = createHash('sha256').update(readFileSync(specPath)).digest('hex')
    expect(actual).toBe(shaFile)
  })

  it('契约端点数量与后端一致量级（防扫描失效导致的空契约）', () => {
    const operations = Object.values(spec.paths).reduce(
      (total, item) => total + Object.keys(item).filter((key) => key !== 'parameters').length,
      0,
    )
    expect(operations).toBeGreaterThan(80)
  })

  it('前端调用点用到的端点全部在契约中声明', () => {
    const missing = CALLED_OPERATIONS.filter(([method, path]) => {
      const item = spec.paths[path]
      return !item || !(method in item)
    })
    expect(missing).toEqual([])
  })

  it('生成物由当前契约生成（每个调用点端点都已落到 .d.ts）', () => {
    const generated = readFileSync(generatedPath, 'utf8')
    const missing = CALLED_OPERATIONS.filter(([, path]) => !generated.includes(`"${path}"`))
    expect(missing).toEqual([])
  })

  it('登记表与代码里的门面调用双向一致（调用点不可能漏登记）', () => {
    const registered = new Set(CALLED_OPERATIONS.map(([method, path]) => `${method} ${path}`))
    const called = new Set(collectCallSites().map(([method, path]) => `${method} ${path}`))

    const unregistered = [...called].filter((item) => !registered.has(item)).sort()
    const stale = [...registered].filter((item) => !called.has(item)).sort()

    expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] })
  })

  it('除门面外没有任何直连 HTTP 或未登记的契约路径字面量', () => {
    const specPaths = new Set(Object.keys(spec.paths))
    const registered = new Set(CALLED_OPERATIONS.map(([, path]) => path))
    const violations: string[] = []

    for (const rel of sourceFiles) {
      if (FACADE_FILES.has(rel)) continue
      const text = readSource(rel)

      if (/from 'axios'/.test(text)) violations.push(`${rel}: 直接 import axios`)
      if (/\brawRequest\./.test(text)) violations.push(`${rel}: 使用 rawRequest（绕过门面）`)
      if (/\brequest\.(get|post|put|delete)\s*\(/.test(text)) {
        violations.push(`${rel}: 直接调用 axios 实例（应改用 api/contract.ts 门面）`)
      }
      for (const match of text.matchAll(/'([^']+)'/g)) {
        const literal = match[1]
        if (specPaths.has(literal) && !registered.has(literal)) {
          violations.push(`${rel}: 出现未登记的契约路径 ${literal}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
