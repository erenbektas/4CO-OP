import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathExists, slugify } from './4coop-paths.mjs'

function runGit(projectRoot, args) {
  return spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8'
  })
}

export function detectBaseBranch(projectRoot) {
  const symbolic = runGit(projectRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (symbolic.status === 0) {
    const value = symbolic.stdout.trim()
    const branch = value.split('/').at(-1)
    if (branch) {
      return branch
    }
  }

  for (const branch of ['main', 'master']) {
    const probe = runGit(projectRoot, ['rev-parse', '--verify', branch])
    if (probe.status === 0) {
      return branch
    }
  }

  throw new Error('Unable to detect a base branch from origin/HEAD, main, or master')
}

export function buildWorktreeInfo(projectRoot, feature) {
  const slug = slugify(feature)
  const repoName = path.basename(projectRoot)
  return {
    branch: `feat/${slug}`,
    path: path.resolve(projectRoot, '..', `${repoName}-wt-${slug}`)
  }
}

export function ensureWorktree(projectRoot, feature) {
  const base = detectBaseBranch(projectRoot)
  const info = buildWorktreeInfo(projectRoot, feature)
  if (pathExists(info.path)) {
    return { ...info, base }
  }

  const branchExists = runGit(projectRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${info.branch}`]).status === 0
  const args = branchExists
    ? ['worktree', 'add', info.path, info.branch]
    : ['worktree', 'add', info.path, '-b', info.branch, base]

  const created = runGit(projectRoot, args)
  if (created.status !== 0) {
    throw new Error(created.stderr.trim() || `Failed to create worktree ${info.path}`)
  }
  return { ...info, base }
}

export function removeWorktree(projectRoot, worktreePath, force = false) {
  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  const removed = runGit(projectRoot, args)
  if (removed.status !== 0) {
    throw new Error(removed.stderr.trim() || `Failed to remove worktree ${worktreePath}`)
  }
}
