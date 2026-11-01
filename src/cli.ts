#!/usr/bin/env node
/** kpm — Kuikly Package Manager CLI 入口（thin wrapper，逻辑在 actions.ts） */
import { Command } from 'commander';
import * as path from 'node:path';
import { makeCtx, runAdd, runConfig, runDoctorAction, runInit, runInstall, runList, runRemove } from './actions.js';
import { ResolveError } from './resolve.js';

const program = new Command();

program
  .name('kpm')
  .description('Kuikly Package Manager — 一份清单，三端（Android/iOS/鸿蒙）自动接线第三方组件')
  .version('0.1.0')
  .option('-p, --path <dir>', '工程根目录（默认当前目录）')
  .option('--refresh', '忽略缓存重新拉取索引/元数据')
  .option('--offline', '仅使用本地缓存（缓存未命中则报错）');

program
  .command('init')
  .description('探测工程结构与目标端，生成 kuikly.pkg.json')
  .option('--force', '已存在时覆盖重探测（保留 dependencies/registries）')
  .action(async (opts) => {
    const root = resolveRoot(program);
    await runInit(makeCtx(root, globalOpts(program)), { force: opts.force });
  });

program
  .command('add <spec>')
  .description('安装组件：<name>[@^1.0.0] 或 <github-url>')
  .option('-y, --yes', '跳过确认直接应用')
  .option('-n, --dry-run', '只预览 diff，不写入')
  .action(async (spec: string, opts) => {
    const root = resolveRoot(program);
    await runAdd(makeCtx(root, globalOpts(program)), spec, { yes: opts.yes, dryRun: opts.dryRun });
  });

program
  .command('remove <name>')
  .description('卸载组件（删除标记区间与 lock 记录）')
  .action(async (name: string) => {
    const root = resolveRoot(program);
    await runRemove(makeCtx(root, globalOpts(program)), name);
  });

program
  .command('install')
  .description('按 kuikly.pkg.json 幂等同步注入并更新 lock')
  .option('--frozen', '严格按 lock（无网络；lock 缺失则失败，CI 用）')
  .action(async (opts) => {
    const root = resolveRoot(program);
    await runInstall(makeCtx(root, globalOpts(program)), { frozen: opts.frozen });
  });

program
  .command('list')
  .description('列出依赖与各端坐标')
  .action(async () => {
    const root = resolveRoot(program);
    await runList(makeCtx(root, globalOpts(program)));
  });

program
  .command('config <action> [key] [value]')
  .description('查看/调整配置：platforms.<端> / paths.<模块>')
  .action(async (action: string, key?: string, value?: string) => {
    const root = resolveRoot(program);
    await runConfig(makeCtx(root, globalOpts(program)), [action, key, value].filter((x) => x !== undefined));
  });

program
  .command('doctor')
  .description('接线完整性体检（标记区间/注册代码/lock 一致性）')
  .action(async () => {
    const root = resolveRoot(program);
    const ok = await runDoctorAction(makeCtx(root, globalOpts(program)));
    if (!ok) process.exitCode = 1;
  });

function resolveRoot(prog: Command): string {
  const opts = prog.opts() as { path?: string };
  return path.resolve(opts.path ?? process.cwd());
}

function globalOpts(prog: Command): { refresh?: boolean; offline?: boolean } {
  const opts = prog.opts() as { refresh?: boolean; offline?: boolean };
  return { refresh: opts.refresh, offline: opts.offline };
}

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof ResolveError) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(e instanceof Error ? `${(e as Error).stack}\n` : `${String(e)}\n`);
    process.exitCode = 1;
  }
});
