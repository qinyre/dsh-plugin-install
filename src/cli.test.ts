import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { dshArgv, validateSpec } from './cli.ts'

describe('validateSpec（防注入：任意下载的入口）', () => {
  it('accepts bare package names', () => {
    expect(validateSpec('dsh-context')).toBeNull()
    expect(validateSpec('@deepseek-ai/dsh-host-apiproxy')).toBeNull()
  })

  it('accepts versioned and git specs', () => {
    expect(validateSpec('dsh-context@^1.2.3')).toBeNull()
    expect(validateSpec('dsh-context@~1.2')).toBeNull()
    expect(validateSpec('dsh-context@=1.2.3')).toBeNull()
    expect(validateSpec('dsh-context@latest')).toBeNull()
    expect(validateSpec('github:user/repo')).toBeNull()
    expect(validateSpec('github:user/repo#a1b2c3d')).toBeNull()
  })

  it('accepts local file and link specs', () => {
    expect(validateSpec('file:../hello-plugin')).toBeNull()
    expect(validateSpec('link:./packages/foo')).toBeNull()
  })

  it('rejects empty and oversized specs', () => {
    expect(validateSpec('')).not.toBeNull()
    expect(validateSpec('x'.repeat(201))).not.toBeNull()
  })

  it('rejects argument injection (leading dash)', () => {
    expect(validateSpec('-S')).not.toBeNull()
    expect(validateSpec('--global-dir一起来')).not.toBeNull()
  })

  it('rejects shell metacharacters', () => {
    for (const spec of ['a; rm -rf /', 'a && b', '$(ls)', '`id`', 'a|b', 'a>out', 'a b c']) {
      expect(validateSpec(spec), spec).not.toBeNull()
    }
  })

  it('rejects whitespace inside the spec', () => {
    expect(validateSpec('dsh context')).not.toBeNull()
  })
})
describe('dshArgv（CLI 调用方式解析）', () => {
  it('reuses the CLI entry when argv names it', () => {
    const entry = 'D:/Program/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const result = dshArgv({
      argv: ['C:/nvm4w/nodejs/node.exe', entry],
      execPath: 'C:/nvm4w/nodejs/node.exe',
      execArgv: [],
    })
    expect(result.viaShell).toBe(false)
    expect(result.args).toEqual([resolve(entry)])
    expect(result.env).toBeUndefined()
  })

  it('resolves the bundled CLI from a desktop-style launch (Electron switches first)', () => {
    const bin = 'D:/App/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const host = 'D:/App/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
    const exists = (p: string): boolean => {
      const normalized = p.replace(/\\/g, '/')
      return normalized === bin || normalized === host
    }
    const result = dshArgv({
      argv: ['D:/App/DeepSeek Harness.exe', '--expose-internals', host, 'D:/ws'],
      execPath: 'D:/App/DeepSeek Harness.exe',
      execArgv: [],
      exists,
    })
    expect(result.file).toBe('D:/App/DeepSeek Harness.exe')
    expect(result.args).toEqual([resolve(bin)])
    expect(result.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(result.viaShell).toBe(false)
    // The entry sits inside the asar archive; only the executable's real
    // directory is a valid child cwd on Windows.
    expect(result.cwd?.replace(/\\/g, '/')).toBe('D:/App')
  })

  it('prefers the desktop CLI entry and mirrors the official dsh.cmd invocation', () => {
    const cli = 'D:/App/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
    const host = 'D:/App/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
    const exists = (p: string): boolean => {
      const normalized = p.replace(/\\/g, '/')
      return normalized === cli || normalized === host
    }
    const result = dshArgv({
      argv: ['D:/App/DeepSeek Harness.exe', '--type=utility', host],
      execPath: 'D:/App/DeepSeek Harness.exe',
      execArgv: [],
      exists,
    })
    expect(result.file).toBe('D:/App/DeepSeek Harness.exe')
    expect(result.args.map((a) => a.replace(/\\/g, '/'))).toEqual(['--expose-internals', cli])
    expect(result.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(result.cwd?.replace(/\\/g, '/')).toBe('D:/App')
    expect(result.viaShell).toBe(false)
  })

  it('falls back to bare dsh via shell when no CLI layout is found', () => {
    const result = dshArgv({ argv: ['node.exe', 'server.js'], execPath: 'node.exe', execArgv: [], exists: () => false })
    expect(result).toMatchObject({ file: 'dsh', viaShell: true })
  })
})
