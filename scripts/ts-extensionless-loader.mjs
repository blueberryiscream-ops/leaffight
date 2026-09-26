// scripts/test-*.ts 用のESMローダ（元は test-core-priority.ts 専用。R2u-2 でそのテストは消えた）。
// tsconfig.json は moduleResolution:"bundler" 前提で core/ 内の相対importが拡張子省略になっている
// （例: `from './board'`）。Node のネイティブ型剥がし実行だけでは拡張子省略を解決できないため、
// テスト実行時だけ '.ts' を補って解決する。ビルド本体（vite/tsc）には影響しない。
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const candidateUrl = new URL(specifier + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(candidateUrl))) {
      return nextResolve(pathToFileURL(fileURLToPath(candidateUrl)).href, context)
    }
  }
  return nextResolve(specifier, context)
}
