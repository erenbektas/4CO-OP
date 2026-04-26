import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  proposeProjectCommands,
  collectManifestSnippets,
  detectNodePackageManager,
  walkShallow,
  isSignalFile
} from '../skill/4co-op/scripts/4coop-detect.mjs'

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '4coop-detect-'))
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(root, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    if (contents === null) {
      fs.mkdirSync(absPath, { recursive: true })
    } else {
      fs.writeFileSync(absPath, contents)
    }
  }
  return root
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

test('detects unknown project with empty dir', () => {
  const root = makeFixture({})
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Unknown')
    assert.equal(result.proposed_build, '')
    assert.equal(result.proposed_test, '')
    assert.equal(result.proposed_lint, '')
  } finally { cleanup(root) }
})

test('detects Node/npm project with scripts', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({
      scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' }
    }),
    'package-lock.json': '{}'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.ok(result.detected_stack.startsWith('Node'))
    assert.match(result.detected_stack, /npm/)
    assert.equal(result.proposed_build, 'npm run build')
    assert.equal(result.proposed_test, 'npm test')
    assert.equal(result.proposed_lint, 'npm run lint')
  } finally { cleanup(root) }
})

test('detects Node/pnpm project via lockfile', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'vitest', lint: 'eslint .' } }),
    'pnpm-lock.yaml': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /pnpm/)
    assert.equal(result.proposed_build, 'pnpm build')
    assert.equal(result.proposed_test, 'pnpm test')
    assert.equal(result.proposed_lint, 'pnpm lint')
  } finally { cleanup(root) }
})

test('detects Node/bun via bun.lockb', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: { test: 'bun test', build: 'bun run build.ts' } }),
    'bun.lockb': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /bun/)
    assert.equal(result.proposed_test, 'bun run test')
    assert.equal(result.proposed_build, 'bun run build')
  } finally { cleanup(root) }
})

test('Node: packageManager field overrides lockfile mtime', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({
      packageManager: 'yarn@4.0.0',
      scripts: { test: 'jest' }
    }),
    'package-lock.json': '{}'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /yarn/)
    assert.equal(result.proposed_test, 'yarn test')
  } finally { cleanup(root) }
})

test('Node: falls back to biome config when no lint script', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    'biome.json': '{}'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.proposed_lint, 'npx biome check .')
  } finally { cleanup(root) }
})

test('Node: falls back to eslint config when no lint script', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    '.eslintrc.json': '{}'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.proposed_lint, 'npx eslint .')
  } finally { cleanup(root) }
})

test('Node: detects Turborepo', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'turbo.json': '{}',
    'package-lock.json': '{}'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Turborepo/)
    assert.equal(result.proposed_build, 'turbo run build')
    assert.equal(result.proposed_test, 'turbo run test')
  } finally { cleanup(root) }
})

test('detects Deno project with tasks', () => {
  const root = makeFixture({
    'deno.json': JSON.stringify({ tasks: { build: 'deno compile', test: 'deno test', lint: 'deno lint' } })
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Deno')
    assert.equal(result.proposed_build, 'deno task build')
    assert.equal(result.proposed_test, 'deno task test')
    assert.equal(result.proposed_lint, 'deno task lint')
  } finally { cleanup(root) }
})

test('detects Python/poetry project', () => {
  const root = makeFixture({
    'pyproject.toml': '[tool.poetry]\nname = "x"\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\n',
    'poetry.lock': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /poetry/)
    assert.equal(result.proposed_build, 'poetry build')
    assert.equal(result.proposed_test, 'poetry run pytest')
    assert.equal(result.proposed_lint, 'poetry run ruff check .')
  } finally { cleanup(root) }
})

test('detects Python/uv project', () => {
  const root = makeFixture({
    'pyproject.toml': '[project]\nname = "x"\n[tool.ruff]\n',
    'uv.lock': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /uv/)
    assert.equal(result.proposed_build, 'uv build')
    assert.equal(result.proposed_lint, 'uv run ruff check .')
  } finally { cleanup(root) }
})

test('detects Python without pyproject (requirements only)', () => {
  const root = makeFixture({
    'requirements.txt': 'pytest\nruff\n',
    'pytest.ini': '[pytest]\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Python/)
    assert.equal(result.proposed_test, 'pytest')
  } finally { cleanup(root) }
})

test('detects Go project with golangci-lint', () => {
  const root = makeFixture({
    'go.mod': 'module example.com/x\n\ngo 1.21\n',
    '.golangci.yml': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Go')
    assert.equal(result.proposed_build, 'go build ./...')
    assert.equal(result.proposed_test, 'go test ./...')
    assert.equal(result.proposed_lint, 'golangci-lint run')
  } finally { cleanup(root) }
})

test('detects Rust workspace', () => {
  const root = makeFixture({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Rust (workspace)')
    assert.equal(result.proposed_build, 'cargo build')
    assert.equal(result.proposed_test, 'cargo test')
    assert.match(result.proposed_lint, /clippy/)
  } finally { cleanup(root) }
})

test('detects Rails app', () => {
  const root = makeFixture({
    'Gemfile': "gem 'rails', '~> 7.0'\ngem 'rubocop'\n",
    'config/application.rb': '# Rails app'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Ruby (Rails)')
    assert.equal(result.proposed_test, 'bin/rails test')
    assert.equal(result.proposed_lint, 'bundle exec rubocop')
  } finally { cleanup(root) }
})

test('detects Ruby with rspec', () => {
  const root = makeFixture({
    'Gemfile': "gem 'rspec'\n",
    '.rspec': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Ruby')
    assert.equal(result.proposed_test, 'bundle exec rspec')
  } finally { cleanup(root) }
})

test('detects PHP/composer with scripts', () => {
  const root = makeFixture({
    'composer.json': JSON.stringify({
      scripts: { test: 'phpunit', lint: 'phpstan analyse', build: 'box compile' }
    })
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'PHP')
    assert.equal(result.proposed_build, 'composer build')
    assert.equal(result.proposed_test, 'composer test')
    assert.equal(result.proposed_lint, 'composer lint')
  } finally { cleanup(root) }
})

test('detects Laravel via artisan', () => {
  const root = makeFixture({
    'composer.json': '{}',
    'artisan': '#!/usr/bin/env php\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Laravel/)
    assert.equal(result.proposed_test, 'php artisan test')
  } finally { cleanup(root) }
})

test('detects Maven, prefers mvnw', () => {
  const root = makeFixture({
    'pom.xml': '<project><artifactId>x</artifactId><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>',
    'mvnw': '#!/bin/sh\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Java (Maven)')
    assert.equal(result.proposed_build, './mvnw package -DskipTests')
    assert.equal(result.proposed_test, './mvnw test')
    assert.equal(result.proposed_lint, './mvnw checkstyle:check')
  } finally { cleanup(root) }
})

test('detects Gradle KMP', () => {
  const root = makeFixture({
    'build.gradle.kts': 'plugins { kotlin("multiplatform") }\n',
    'gradlew': '#!/bin/sh\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Kotlin Multiplatform')
    assert.equal(result.proposed_test, './gradlew allTests')
  } finally { cleanup(root) }
})

test('detects Android Gradle', () => {
  const root = makeFixture({
    'build.gradle.kts': 'plugins { id("com.android.application") }\n',
    'gradlew': '#!/bin/sh\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Android/)
    assert.equal(result.proposed_test, './gradlew connectedAndroidTest')
  } finally { cleanup(root) }
})

test('detects .NET via csproj in subdir', () => {
  const root = makeFixture({
    'src/Foo/Foo.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, '.NET')
    assert.equal(result.proposed_build, 'dotnet build')
    assert.equal(result.proposed_test, 'dotnet test')
  } finally { cleanup(root) }
})

test('detects Swift Package', () => {
  const root = makeFixture({ 'Package.swift': '// swift-tools-version: 5.9\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Swift/)
    assert.equal(result.proposed_build, 'swift build')
    assert.equal(result.proposed_test, 'swift test')
  } finally { cleanup(root) }
})

test('detects Flutter', () => {
  const root = makeFixture({
    'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Flutter')
    assert.equal(result.proposed_test, 'flutter test')
    assert.equal(result.proposed_lint, 'flutter analyze')
  } finally { cleanup(root) }
})

test('detects Dart package (non-Flutter)', () => {
  const root = makeFixture({
    'pubspec.yaml': 'name: mypkg\ndependencies:\n  args: ^2.0.0\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Dart')
    assert.equal(result.proposed_test, 'dart test')
  } finally { cleanup(root) }
})

test('detects Elixir/Mix with credo', () => {
  const root = makeFixture({
    'mix.exs': 'defmodule App.MixProject do\n  defp deps, do: [{:credo, "~> 1.7"}]\nend\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Elixir/)
    assert.equal(result.proposed_test, 'mix test')
    assert.equal(result.proposed_lint, 'mix credo')
  } finally { cleanup(root) }
})

test('detects Haskell/Stack', () => {
  const root = makeFixture({ 'stack.yaml': 'resolver: lts-22.0\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Stack/)
    assert.equal(result.proposed_build, 'stack build')
  } finally { cleanup(root) }
})

test('detects OCaml/Dune', () => {
  const root = makeFixture({ 'dune-project': '(lang dune 3.0)\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /OCaml/)
    assert.equal(result.proposed_build, 'dune build')
  } finally { cleanup(root) }
})

test('detects Clojure deps.edn', () => {
  const root = makeFixture({ 'deps.edn': '{:aliases {:test {:extra-paths ["test"]} :build {}}}' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Clojure/)
    assert.equal(result.proposed_build, 'clojure -T:build')
    assert.equal(result.proposed_test, 'clojure -M:test')
  } finally { cleanup(root) }
})

test('detects Zig', () => {
  const root = makeFixture({ 'build.zig': 'const std = @import("std");\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Zig')
    assert.equal(result.proposed_build, 'zig build')
  } finally { cleanup(root) }
})

test('detects Julia by [deps] section', () => {
  const root = makeFixture({
    'Project.toml': 'name = "Foo"\nuuid = "abc"\n\n[deps]\nExample = "7876af07-990d"\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Julia')
    assert.match(result.proposed_test, /Pkg\.test/)
  } finally { cleanup(root) }
})

test('CMake with presets', () => {
  const root = makeFixture({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(x)\n',
    'CMakePresets.json': JSON.stringify({ configurePresets: [{ name: 'default' }] })
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'CMake')
    assert.match(result.proposed_build, /--preset default/)
  } finally { cleanup(root) }
})

test('detects Bazel', () => {
  const root = makeFixture({ 'MODULE.bazel': 'module(name = "x")\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Bazel')
    assert.equal(result.proposed_build, 'bazel build //...')
    assert.equal(result.proposed_test, 'bazel test //...')
  } finally { cleanup(root) }
})

test('detects Terraform', () => {
  const root = makeFixture({ 'main.tf': 'resource "null_resource" "x" {}\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Terraform')
    assert.match(result.proposed_build, /terraform init/)
  } finally { cleanup(root) }
})

test('detects Nix flake', () => {
  const root = makeFixture({ 'flake.nix': '{ outputs = _: {}; }\n' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Nix/)
    assert.equal(result.proposed_build, 'nix build')
    assert.equal(result.proposed_test, 'nix flake check')
  } finally { cleanup(root) }
})

test('Dockerfile-only repo', () => {
  const root = makeFixture({
    'Dockerfile': 'FROM alpine\n',
    'hadolint.yaml': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Docker')
    assert.equal(result.proposed_build, 'docker build .')
    assert.equal(result.proposed_lint, 'hadolint Dockerfile')
  } finally { cleanup(root) }
})

test('shell-only repo with bats', () => {
  const root = makeFixture({
    'install.sh': '#!/bin/bash\n',
    'tests/foo.bats': '@test "x" { true; }\n',
    '.shellcheckrc': ''
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Shell')
    assert.equal(result.proposed_test, 'bats tests/')
    assert.equal(result.proposed_lint, 'shellcheck **/*.sh')
  } finally { cleanup(root) }
})

test('justfile takes precedence over inferred Node commands', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
    'package-lock.json': '{}',
    'justfile': 'test:\n\tpnpm test\n\nlint:\n\tpnpm eslint\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.proposed_build, 'npm run build', 'build from package.json stays')
    assert.equal(result.proposed_test, 'just test', 'test comes from justfile recipe')
    assert.equal(result.proposed_lint, 'just lint')
  } finally { cleanup(root) }
})

test('Taskfile provides build/test/lint when Node has none', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ scripts: {} }),
    'Taskfile.yml': 'version: "3"\ntasks:\n  build:\n    cmds: ["tsc"]\n  test:\n    cmds: ["vitest"]\n  lint:\n    cmds: ["eslint ."]\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.proposed_build, 'task build')
    assert.equal(result.proposed_test, 'task test')
    assert.equal(result.proposed_lint, 'task lint')
  } finally { cleanup(root) }
})

test('Makefile fills in missing commands for Python project', () => {
  const root = makeFixture({
    'pyproject.toml': '[project]\nname = "x"\n',
    'Makefile': '.PHONY: build test lint\nbuild:\n\techo b\ntest:\n\techo t\nlint:\n\techo l\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /Python/)
    assert.equal(result.proposed_build, 'make build')
    assert.equal(result.proposed_test, 'make test')
    assert.equal(result.proposed_lint, 'make lint')
  } finally { cleanup(root) }
})

test('Makefile-only repo uses make targets as fallback', () => {
  const root = makeFixture({
    'Makefile': '.PHONY: build test lint\nbuild:\n\tgcc -o bin/x src/*.c\ntest:\n\t./bin/x --self-test\nlint:\n\tclang-tidy src/*.c\n'
  })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'Generic (Makefile)')
    assert.equal(result.proposed_build, 'make build')
    assert.equal(result.proposed_test, 'make test')
    assert.equal(result.proposed_lint, 'make lint')
  } finally { cleanup(root) }
})

test('tool-config-only repo (just tsconfig.json) proposes typecheck lint', () => {
  const root = makeFixture({ 'tsconfig.json': '{}' })
  try {
    const result = proposeProjectCommands(root)
    assert.equal(result.detected_stack, 'TypeScript')
    assert.match(result.proposed_lint, /tsc/)
  } finally { cleanup(root) }
})

test('ESLint config only (no manifest) still proposes lint', () => {
  const root = makeFixture({ '.eslintrc.json': '{}' })
  try {
    const result = proposeProjectCommands(root)
    assert.match(result.detected_stack, /ESLint/)
    assert.equal(result.proposed_lint, 'npx eslint .')
  } finally { cleanup(root) }
})

test('collectManifestSnippets picks up nested manifests in monorepo', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
    'apps/api/pyproject.toml': '[project]\nname = "api"\n',
    'apps/web/package.json': JSON.stringify({ name: 'web' }),
    'pnpm-lock.yaml': ''
  })
  try {
    const snippets = collectManifestSnippets(root)
    const paths = snippets.map(s => s.relative_path)
    assert.ok(paths.includes('package.json'))
    assert.ok(paths.some(p => p === 'apps/api/pyproject.toml'), `expected apps/api/pyproject.toml, got ${paths.join(', ')}`)
    assert.ok(paths.some(p => p === 'apps/web/package.json'))
    const lockEntry = snippets.find(s => s.relative_path === 'pnpm-lock.yaml')
    assert.ok(lockEntry, 'lockfile entry should be present')
    assert.match(lockEntry.snippet, /pnpm-lock.yaml present/)
  } finally { cleanup(root) }
})

test('walkShallow skips node_modules and .git', () => {
  const root = makeFixture({
    'package.json': '{}',
    'node_modules/foo/package.json': '{}',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'src/index.js': '// hi\n'
  })
  try {
    const names = walkShallow(root).map(e => e.name)
    assert.ok(names.includes('package.json'))
    assert.ok(!names.some(n => n === 'HEAD'))
  } finally { cleanup(root) }
})

test('isSignalFile recognizes primary manifests, lockfiles, and tool configs', () => {
  assert.equal(isSignalFile('package.json'), true)
  assert.equal(isSignalFile('pnpm-lock.yaml'), true)
  assert.equal(isSignalFile('.eslintrc.json'), true)
  assert.equal(isSignalFile('README.md'), false)
})

test('detectNodePackageManager prefers packageManager field', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
    'package-lock.json': '{}'
  })
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    assert.equal(detectNodePackageManager(root, pkg), 'pnpm')
  } finally { cleanup(root) }
})
