import fs from 'node:fs'
import path from 'node:path'
import {
  pathExists,
  readTextIfExists,
  relativeProjectPath,
  toPosixPath
} from './4coop-paths.mjs'

const WALK_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'bin', 'obj',
  'vendor', '.venv', 'venv', 'env', '__pycache__',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache',
  'coverage', '.nyc_output',
  '.idea', '.vscode', '.DS_Store', '.4co-op'
])

const SNIPPET_LINE_LIMIT = 80
const MANIFEST_WALK_DEPTH = 2
const MANIFEST_MAX_SNIPPETS = 40

const PRIMARY_MANIFEST_NAMES = new Set([
  'package.json', 'deno.json', 'deno.jsonc', 'bunfig.toml',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'environment.yml', 'environment.yaml',
  'go.mod', 'go.work',
  'Cargo.toml',
  'Gemfile', 'Rakefile', 'Gemfile.lock',
  'composer.json',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt', 'project.clj', 'deps.edn',
  'global.json', 'Directory.Build.props', 'paket.dependencies',
  'Package.swift', 'Podfile', 'Cartfile',
  'pubspec.yaml',
  'mix.exs',
  'stack.yaml', 'cabal.project', 'package.yaml',
  'dune-project',
  'rebar.config',
  'build.zig', 'build.zig.zon',
  'shard.yml',
  'DESCRIPTION', 'renv.lock',
  'Project.toml',
  'CMakeLists.txt', 'meson.build',
  'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel',
  'BUCK',
  'configure.ac', 'configure.in', 'Makefile.am',
  'Makefile', 'GNUmakefile',
  'justfile', 'Justfile', '.justfile',
  'Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml',
  'flake.nix', 'default.nix', 'shell.nix',
  'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'compose.yml', 'docker-compose.yaml',
  'Pulumi.yaml', 'ansible.cfg'
])

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'deno.lock',
  'poetry.lock', 'pdm.lock', 'uv.lock', 'Pipfile.lock', 'conda-lock.yml',
  'go.sum', 'Cargo.lock', 'Gemfile.lock', 'composer.lock',
  'Package.resolved', 'pubspec.lock', 'mix.lock',
  'flake.lock', '.terraform.lock.hcl'
])

const TOOL_CONFIG_FILES = new Set([
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  'biome.json', 'biome.jsonc',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'tsconfig.json', 'jsconfig.json',
  '.stylelintrc', '.stylelintrc.json', 'stylelint.config.js',
  'ruff.toml', '.ruff.toml',
  '.flake8', 'mypy.ini', '.mypy.ini', '.pylintrc', 'pylintrc',
  'pytest.ini', 'pytest.toml', 'tox.ini', 'noxfile.py', 'conftest.py',
  '.rubocop.yml', '.standard.yml',
  'rustfmt.toml', '.rustfmt.toml', 'clippy.toml', '.clippy.toml',
  '.golangci.yml', '.golangci.yaml', '.golangci.toml',
  '.clang-format', '.clang-tidy',
  '.scalafmt.conf', '.ocamlformat',
  'hadolint.yaml', '.hadolint.yaml',
  '.shellcheckrc', '.editorconfig', '.pre-commit-config.yaml',
  'analysis_options.yaml',
  'nx.json', 'turbo.json', 'lerna.json', 'rush.json', 'pnpm-workspace.yaml',
  'CMakePresets.json',
  '.bazelrc', '.bazelversion',
  '.tool-versions', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.terraform-version'
])

export function isSignalFile(name) {
  return PRIMARY_MANIFEST_NAMES.has(name)
    || LOCKFILE_NAMES.has(name)
    || TOOL_CONFIG_FILES.has(name)
}

export function walkShallow(root, { maxDepth = MANIFEST_WALK_DEPTH, includeDirs = false } = {}) {
  const results = []
  if (!pathExists(root)) return results

  const visit = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (WALK_IGNORE_DIRS.has(entry.name)) continue
      const absPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (includeDirs) {
          results.push({ absPath, name: entry.name, isDir: true, depth })
        }
        if (depth < maxDepth) {
          visit(absPath, depth + 1)
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        results.push({ absPath, name: entry.name, isDir: false, depth })
      }
    }
  }

  visit(root, 0)
  return results
}

function safeJsonParse(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function firstLines(text, limit = SNIPPET_LINE_LIMIT) {
  return String(text ?? '').split(/\r?\n/).slice(0, limit).join('\n')
}

function tomlHasSection(text, section) {
  if (!text) return false
  const pattern = new RegExp(`^\\[${section.replace(/\./g, '\\.')}(?:\\s*\\.|\\s*\\])`, 'm')
  return pattern.test(text)
}

function tomlStringValue(text, key) {
  if (!text) return null
  const pattern = new RegExp(`^${key}\\s*=\\s*['"](.+?)['"]`, 'm')
  const match = pattern.exec(text)
  return match ? match[1] : null
}

function parseMakefileTargets(text) {
  if (!text) return []
  const targets = new Set()
  const phonyLines = text.match(/^\s*\.PHONY\s*:\s*(.+)$/gm) ?? []
  for (const line of phonyLines) {
    const body = line.replace(/^\s*\.PHONY\s*:\s*/, '')
    for (const name of body.split(/\s+/)) {
      if (name) targets.add(name)
    }
  }
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line || line.startsWith('\t')) continue
    if (line.startsWith('#')) continue
    const match = /^(?!\.)([A-Za-z0-9_./-]+)\s*:(?!=)/.exec(line)
    if (match) targets.add(match[1])
  }
  return [...targets]
}

function parseJustfileRecipes(text) {
  if (!text) return []
  const recipes = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:[a-zA-Z0-9_+*?=()'",\s]*)?:(?![=])/.exec(line)
    if (match) recipes.add(match[1])
  }
  return [...recipes]
}

function parseTaskfileTasks(text) {
  if (!text) return []
  const tasks = new Set()
  const lines = text.split(/\r?\n/)
  let inTasks = false
  let tasksIndent = -1
  for (const line of lines) {
    if (/^tasks\s*:/.test(line)) { inTasks = true; tasksIndent = 0; continue }
    if (!inTasks) continue
    if (/^\S/.test(line)) { inTasks = false; continue }
    const match = /^(\s+)([A-Za-z0-9_:-]+)\s*:\s*$/.exec(line) ?? /^(\s+)([A-Za-z0-9_:-]+)\s*:\s*\S/.exec(line)
    if (!match) continue
    const indent = match[1].length
    if (tasksIndent < 0 || indent < tasksIndent || tasksIndent === 0) tasksIndent = indent
    if (indent === tasksIndent) tasks.add(match[2])
  }
  return [...tasks]
}

function yamlHasKey(text, key) {
  if (!text) return false
  const pattern = new RegExp(`^\\s*${key}\\s*:`, 'm')
  return pattern.test(text)
}

function yamlStringValue(text, key) {
  if (!text) return null
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*['\"]?([^'\"\\n]+?)['\"]?\\s*$`, 'm')
  const match = pattern.exec(text)
  return match ? match[1].trim() : null
}

export function detectNodePackageManager(projectRoot, packageJson) {
  const pmField = packageJson?.packageManager
  if (typeof pmField === 'string') {
    const name = pmField.split('@')[0].trim()
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name
  }
  const candidates = [
    { file: 'bun.lockb', pm: 'bun' },
    { file: 'bun.lock', pm: 'bun' },
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'yarn.lock', pm: 'yarn' },
    { file: 'package-lock.json', pm: 'npm' }
  ]
  const present = candidates
    .map(entry => {
      const absPath = path.join(projectRoot, entry.file)
      if (!pathExists(absPath)) return null
      try {
        return { ...entry, mtime: fs.statSync(absPath).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
  if (present.length === 0) return 'npm'
  present.sort((a, b) => b.mtime - a.mtime)
  return present[0].pm
}

function nodeRunScript(runner, scriptName) {
  if (runner === 'npm') {
    if (['test', 'start'].includes(scriptName)) return `npm ${scriptName}`
    return `npm run ${scriptName}`
  }
  if (runner === 'pnpm') return `pnpm ${scriptName}`
  if (runner === 'yarn') return `yarn ${scriptName}`
  if (runner === 'bun') return `bun run ${scriptName}`
  return `npm run ${scriptName}`
}

function summarizeNode(projectRoot, packageJsonText) {
  const packageJson = safeJsonParse(packageJsonText) ?? {}
  const scripts = packageJson.scripts ?? {}
  const runner = detectNodePackageManager(projectRoot, packageJson)
  const hasTurbo = pathExists(path.join(projectRoot, 'turbo.json'))
  const hasNx = pathExists(path.join(projectRoot, 'nx.json'))
  const hasPnpmWorkspace = pathExists(path.join(projectRoot, 'pnpm-workspace.yaml'))

  const pickScript = (names) => {
    for (const name of names) {
      if (scripts[name]) return nodeRunScript(runner, name)
    }
    return ''
  }

  let build = pickScript(['build', 'compile', 'bundle'])
  let test = pickScript(['test', 'test:unit', 'tests'])
  let lint = pickScript(['lint', 'lint:all', 'check'])

  if (!build && hasTurbo) build = 'turbo run build'
  if (!test && hasTurbo) test = 'turbo run test'
  if (!lint && hasTurbo) lint = 'turbo run lint'
  if (!build && hasNx) build = 'nx run-many -t build'
  if (!test && hasNx) test = 'nx run-many -t test'
  if (!lint && hasNx) lint = 'nx run-many -t lint'

  if (!lint) {
    if (pathExists(path.join(projectRoot, 'biome.json')) || pathExists(path.join(projectRoot, 'biome.jsonc'))) {
      lint = 'npx biome check .'
    } else if (hasEslintConfig(projectRoot)) {
      lint = 'npx eslint .'
    }
  }

  const workspace = hasTurbo ? ' (Turborepo)'
    : hasNx ? ' (Nx)'
    : hasPnpmWorkspace ? ' (pnpm workspace)'
    : Array.isArray(packageJson.workspaces) || packageJson.workspaces?.packages ? ' (workspaces)'
    : ''

  const detectedScripts = Object.keys(scripts).length
  const confidence = detectedScripts > 0 ? 0.95 : 0.7

  return {
    detected_stack: `Node (${runner})${workspace}`,
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence,
    summary: `Looks like a Node project using ${runner}${workspace}.`
  }
}

function hasEslintConfig(projectRoot) {
  return [
    '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.mjs', '.eslintrc.yml', '.eslintrc.yaml',
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'
  ].some(name => pathExists(path.join(projectRoot, name)))
}

function summarizeDeno(projectRoot) {
  const denoJson = readTextIfExists(path.join(projectRoot, 'deno.json'))
    ?? readTextIfExists(path.join(projectRoot, 'deno.jsonc'))
  const parsed = safeJsonParse(denoJson?.replace(/\/\/.*$/gm, '')) ?? {}
  const tasks = parsed.tasks ?? {}
  const build = tasks.build ? 'deno task build' : ''
  const test = tasks.test ? 'deno task test' : 'deno test'
  const lint = tasks.lint ? 'deno task lint' : 'deno lint'
  return {
    detected_stack: 'Deno',
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence: 0.85,
    summary: 'Looks like a Deno project.'
  }
}

function summarizePython(projectRoot) {
  const pyprojectPath = path.join(projectRoot, 'pyproject.toml')
  const pyproject = readTextIfExists(pyprojectPath) ?? ''

  let runner = 'python'
  let runnerPrefix = ''
  let detectedTool = 'pip'

  if (pathExists(path.join(projectRoot, 'uv.lock'))) {
    runner = 'uv'; runnerPrefix = 'uv run '; detectedTool = 'uv'
  } else if (pathExists(path.join(projectRoot, 'poetry.lock')) || tomlHasSection(pyproject, 'tool.poetry')) {
    runner = 'poetry'; runnerPrefix = 'poetry run '; detectedTool = 'poetry'
  } else if (pathExists(path.join(projectRoot, 'pdm.lock')) || tomlHasSection(pyproject, 'tool.pdm')) {
    runner = 'pdm'; runnerPrefix = 'pdm run '; detectedTool = 'pdm'
  } else if (tomlHasSection(pyproject, 'tool.hatch')) {
    runner = 'hatch'; runnerPrefix = 'hatch run '; detectedTool = 'hatch'
  } else if (pathExists(path.join(projectRoot, 'Pipfile.lock')) || pathExists(path.join(projectRoot, 'Pipfile'))) {
    runner = 'pipenv'; runnerPrefix = 'pipenv run '; detectedTool = 'pipenv'
  }

  const hasPytest = tomlHasSection(pyproject, 'tool.pytest.ini_options')
    || pathExists(path.join(projectRoot, 'pytest.ini'))
    || pathExists(path.join(projectRoot, 'conftest.py'))
  const hasRuff = tomlHasSection(pyproject, 'tool.ruff')
    || pathExists(path.join(projectRoot, 'ruff.toml'))
    || pathExists(path.join(projectRoot, '.ruff.toml'))
  const hasBlack = tomlHasSection(pyproject, 'tool.black')
  const hasMypy = tomlHasSection(pyproject, 'tool.mypy') || pathExists(path.join(projectRoot, 'mypy.ini'))
  const hasFlake8 = pathExists(path.join(projectRoot, '.flake8'))
  const hasBuildSystem = tomlHasSection(pyproject, 'build-system') || pathExists(path.join(projectRoot, 'setup.py'))

  let build = ''
  if (runner === 'poetry') build = 'poetry build'
  else if (runner === 'pdm') build = 'pdm build'
  else if (runner === 'hatch') build = 'hatch build'
  else if (runner === 'uv') build = 'uv build'
  else if (hasBuildSystem) build = 'python -m build'

  const test = hasPytest ? `${runnerPrefix}pytest` : ''
  let lint = ''
  if (hasRuff) lint = `${runnerPrefix}ruff check .`
  else if (hasBlack) lint = `${runnerPrefix}black --check .`
  else if (hasFlake8) lint = `${runnerPrefix}flake8`
  else if (hasMypy) lint = `${runnerPrefix}mypy .`

  return {
    detected_stack: `Python (${detectedTool})`,
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence: hasPytest || hasRuff ? 0.85 : 0.7,
    summary: `Looks like a Python project using ${detectedTool}.`
  }
}

function summarizeGo(projectRoot) {
  const hasGolangciLint = ['.golangci.yml', '.golangci.yaml', '.golangci.toml']
    .some(name => pathExists(path.join(projectRoot, name)))
  return {
    detected_stack: 'Go',
    proposed_build: 'go build ./...',
    proposed_test: 'go test ./...',
    proposed_lint: hasGolangciLint ? 'golangci-lint run' : 'go vet ./...',
    confidence: 0.85,
    summary: 'Looks like a Go project.'
  }
}

function summarizeRust(projectRoot) {
  const cargoText = readTextIfExists(path.join(projectRoot, 'Cargo.toml')) ?? ''
  const isWorkspace = tomlHasSection(cargoText, 'workspace')
  return {
    detected_stack: isWorkspace ? 'Rust (workspace)' : 'Rust',
    proposed_build: 'cargo build',
    proposed_test: 'cargo test',
    proposed_lint: 'cargo clippy --all-targets -- -D warnings',
    confidence: 0.9,
    summary: isWorkspace ? 'Looks like a Rust workspace.' : 'Looks like a Rust project.'
  }
}

function summarizeRuby(projectRoot) {
  const gemfile = readTextIfExists(path.join(projectRoot, 'Gemfile')) ?? ''
  const isRails = pathExists(path.join(projectRoot, 'config/application.rb'))
    || /gem\s+['"]rails['"]/.test(gemfile)
  const hasRspec = /gem\s+['"]rspec/.test(gemfile) || pathExists(path.join(projectRoot, '.rspec'))
  const hasRubocop = /gem\s+['"]rubocop/.test(gemfile) || pathExists(path.join(projectRoot, '.rubocop.yml'))
  const hasRakefile = pathExists(path.join(projectRoot, 'Rakefile'))

  let test = 'bundle exec rake'
  if (isRails) test = 'bin/rails test'
  else if (hasRspec) test = 'bundle exec rspec'
  else if (!hasRakefile) test = ''

  const lint = hasRubocop ? 'bundle exec rubocop' : ''
  const build = ''

  return {
    detected_stack: isRails ? 'Ruby (Rails)' : 'Ruby',
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence: 0.8,
    summary: isRails ? 'Looks like a Rails app.' : 'Looks like a Ruby project.'
  }
}

function summarizePhp(projectRoot) {
  const composerText = readTextIfExists(path.join(projectRoot, 'composer.json'))
  const composer = safeJsonParse(composerText) ?? {}
  const scripts = composer.scripts ?? {}
  const pick = (keys) => {
    for (const key of keys) if (scripts[key]) return `composer ${key}`
    return ''
  }
  const build = pick(['build'])
  let test = pick(['test', 'phpunit', 'pest'])
  let lint = pick(['lint', 'phpstan', 'psalm', 'cs-check'])

  if (!test) {
    if (pathExists(path.join(projectRoot, 'phpunit.xml')) || pathExists(path.join(projectRoot, 'phpunit.xml.dist'))) {
      test = 'vendor/bin/phpunit'
    } else if (pathExists(path.join(projectRoot, 'pest.xml'))) {
      test = 'vendor/bin/pest'
    }
  }
  if (!lint) {
    if (pathExists(path.join(projectRoot, 'phpstan.neon')) || pathExists(path.join(projectRoot, 'phpstan.neon.dist'))) {
      lint = 'vendor/bin/phpstan analyse'
    } else if (pathExists(path.join(projectRoot, 'psalm.xml'))) {
      lint = 'vendor/bin/psalm'
    }
  }

  const isLaravel = pathExists(path.join(projectRoot, 'artisan'))
  if (isLaravel && !test) test = 'php artisan test'

  return {
    detected_stack: isLaravel ? 'PHP (Laravel)' : 'PHP',
    proposed_build: build,
    proposed_test: test,
    proposed_lint: lint,
    confidence: 0.8,
    summary: isLaravel ? 'Looks like a Laravel app.' : 'Looks like a PHP/Composer project.'
  }
}

function summarizeMaven(projectRoot) {
  const mvn = pathExists(path.join(projectRoot, 'mvnw')) ? './mvnw' : 'mvn'
  const pom = readTextIfExists(path.join(projectRoot, 'pom.xml')) ?? ''
  let lint = ''
  if (/<artifactId>(spotless-maven-plugin|maven-checkstyle-plugin|spotbugs-maven-plugin|maven-pmd-plugin)<\/artifactId>/.test(pom)) {
    if (/spotless/i.test(pom)) lint = `${mvn} spotless:check`
    else if (/checkstyle/i.test(pom)) lint = `${mvn} checkstyle:check`
    else if (/spotbugs/i.test(pom)) lint = `${mvn} spotbugs:check`
    else if (/pmd/i.test(pom)) lint = `${mvn} pmd:check`
  }
  return {
    detected_stack: 'Java (Maven)',
    proposed_build: `${mvn} package -DskipTests`,
    proposed_test: `${mvn} test`,
    proposed_lint: lint,
    confidence: 0.85,
    summary: 'Looks like a Maven project.'
  }
}

function summarizeGradle(projectRoot) {
  const gradlew = pathExists(path.join(projectRoot, 'gradlew')) ? './gradlew' : 'gradle'
  const buildScript = readTextIfExists(path.join(projectRoot, 'build.gradle.kts'))
    ?? readTextIfExists(path.join(projectRoot, 'build.gradle')) ?? ''
  const hasKtlint = /ktlint/i.test(buildScript)
  const hasSpotless = /spotless/i.test(buildScript)
  const isAndroid = /com\.android\.(application|library)/.test(buildScript)
  const isKmp = /kotlin\(["']multiplatform["']\)/.test(buildScript) || /kotlin-multiplatform/.test(buildScript)

  let test = `${gradlew} test`
  if (isAndroid) test = `${gradlew} connectedAndroidTest`
  else if (isKmp) test = `${gradlew} allTests`

  let lint = `${gradlew} check`
  if (hasSpotless) lint = `${gradlew} spotlessCheck`
  else if (hasKtlint) lint = `${gradlew} ktlintCheck`

  return {
    detected_stack: isAndroid ? 'Android (Gradle)' : isKmp ? 'Kotlin Multiplatform' : 'Java/Kotlin (Gradle)',
    proposed_build: `${gradlew} build -x test`,
    proposed_test: test,
    proposed_lint: lint,
    confidence: 0.85,
    summary: isAndroid ? 'Looks like an Android Gradle project.'
      : isKmp ? 'Looks like a Kotlin Multiplatform project.'
      : 'Looks like a Gradle project.'
  }
}

function summarizeDotnet() {
  return {
    detected_stack: '.NET',
    proposed_build: 'dotnet build',
    proposed_test: 'dotnet test',
    proposed_lint: 'dotnet format --verify-no-changes',
    confidence: 0.85,
    summary: 'Looks like a .NET project.'
  }
}

function summarizeSwiftPM() {
  return {
    detected_stack: 'Swift (SwiftPM)',
    proposed_build: 'swift build',
    proposed_test: 'swift test',
    proposed_lint: '',
    confidence: 0.85,
    summary: 'Looks like a SwiftPM package.'
  }
}

function summarizeElixir(projectRoot) {
  const mixExs = readTextIfExists(path.join(projectRoot, 'mix.exs')) ?? ''
  const hasCredo = /:credo/.test(mixExs)
  return {
    detected_stack: 'Elixir (Mix)',
    proposed_build: 'mix compile',
    proposed_test: 'mix test',
    proposed_lint: hasCredo ? 'mix credo' : 'mix format --check-formatted',
    confidence: 0.85,
    summary: 'Looks like an Elixir/Mix project.'
  }
}

function summarizeDart(projectRoot) {
  const pubspec = readTextIfExists(path.join(projectRoot, 'pubspec.yaml')) ?? ''
  const isFlutter = /^\s*flutter\s*:/m.test(pubspec) || /flutter:\s*$/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec)
  if (isFlutter) {
    return {
      detected_stack: 'Flutter',
      proposed_build: 'flutter build apk',
      proposed_test: 'flutter test',
      proposed_lint: 'flutter analyze',
      confidence: 0.8,
      summary: 'Looks like a Flutter app.'
    }
  }
  return {
    detected_stack: 'Dart',
    proposed_build: '',
    proposed_test: 'dart test',
    proposed_lint: 'dart analyze',
    confidence: 0.85,
    summary: 'Looks like a Dart package.'
  }
}

function summarizeHaskell(projectRoot) {
  const useStack = pathExists(path.join(projectRoot, 'stack.yaml'))
  if (useStack) {
    return {
      detected_stack: 'Haskell (Stack)',
      proposed_build: 'stack build',
      proposed_test: 'stack test',
      proposed_lint: pathExists(path.join(projectRoot, '.hlint.yaml')) ? 'hlint .' : '',
      confidence: 0.8,
      summary: 'Looks like a Haskell/Stack project.'
    }
  }
  return {
    detected_stack: 'Haskell (Cabal)',
    proposed_build: 'cabal build',
    proposed_test: 'cabal test',
    proposed_lint: pathExists(path.join(projectRoot, '.hlint.yaml')) ? 'hlint .' : '',
    confidence: 0.8,
    summary: 'Looks like a Haskell/Cabal project.'
  }
}

function summarizeOCaml() {
  return {
    detected_stack: 'OCaml (Dune)',
    proposed_build: 'dune build',
    proposed_test: 'dune runtest',
    proposed_lint: 'dune build @fmt',
    confidence: 0.8,
    summary: 'Looks like an OCaml/Dune project.'
  }
}

function summarizeErlang() {
  return {
    detected_stack: 'Erlang (rebar3)',
    proposed_build: 'rebar3 compile',
    proposed_test: 'rebar3 eunit',
    proposed_lint: 'rebar3 dialyzer',
    confidence: 0.8,
    summary: 'Looks like an Erlang/rebar3 project.'
  }
}

function summarizeClojure(projectRoot) {
  if (pathExists(path.join(projectRoot, 'deps.edn'))) {
    const deps = readTextIfExists(path.join(projectRoot, 'deps.edn')) ?? ''
    const hasTest = /:test\b/.test(deps)
    const hasBuild = /:build\b/.test(deps)
    return {
      detected_stack: 'Clojure (deps.edn)',
      proposed_build: hasBuild ? 'clojure -T:build' : '',
      proposed_test: hasTest ? 'clojure -M:test' : '',
      proposed_lint: pathExists(path.join(projectRoot, '.clj-kondo')) ? 'clj-kondo --lint src' : '',
      confidence: 0.75,
      summary: 'Looks like a Clojure (deps.edn) project.'
    }
  }
  return {
    detected_stack: 'Clojure (Leiningen)',
    proposed_build: 'lein uberjar',
    proposed_test: 'lein test',
    proposed_lint: '',
    confidence: 0.75,
    summary: 'Looks like a Leiningen project.'
  }
}

function summarizeZig() {
  return {
    detected_stack: 'Zig',
    proposed_build: 'zig build',
    proposed_test: 'zig build test',
    proposed_lint: 'zig fmt --check .',
    confidence: 0.8,
    summary: 'Looks like a Zig project.'
  }
}

function summarizeNim() {
  return {
    detected_stack: 'Nim',
    proposed_build: 'nimble build',
    proposed_test: 'nimble test',
    proposed_lint: '',
    confidence: 0.75,
    summary: 'Looks like a Nim/Nimble project.'
  }
}

function summarizeCrystal() {
  return {
    detected_stack: 'Crystal',
    proposed_build: 'shards build',
    proposed_test: 'crystal spec',
    proposed_lint: 'crystal tool format --check',
    confidence: 0.75,
    summary: 'Looks like a Crystal project.'
  }
}

function summarizeR() {
  return {
    detected_stack: 'R',
    proposed_build: 'R CMD build .',
    proposed_test: "Rscript -e 'devtools::test()'",
    proposed_lint: "Rscript -e 'lintr::lint_package()'",
    confidence: 0.7,
    summary: 'Looks like an R package.'
  }
}

function summarizeJulia(projectRoot) {
  const projectToml = readTextIfExists(path.join(projectRoot, 'Project.toml')) ?? ''
  if (tomlHasSection(projectToml, 'tool.poetry') || tomlHasSection(projectToml, 'project')) {
    return summarizePython(projectRoot)
  }
  if (!tomlHasSection(projectToml, 'deps') && !tomlHasSection(projectToml, 'compat')) {
    return null
  }
  return {
    detected_stack: 'Julia',
    proposed_build: "julia --project=. -e 'using Pkg; Pkg.instantiate()'",
    proposed_test: "julia --project=. -e 'using Pkg; Pkg.test()'",
    proposed_lint: '',
    confidence: 0.75,
    summary: 'Looks like a Julia project.'
  }
}

function summarizeCMake(projectRoot) {
  const presets = safeJsonParse(readTextIfExists(path.join(projectRoot, 'CMakePresets.json')))
  const defaultPreset = presets?.configurePresets?.[0]?.name
  return {
    detected_stack: 'CMake',
    proposed_build: defaultPreset ? `cmake --build --preset ${defaultPreset}` : 'cmake -B build && cmake --build build',
    proposed_test: defaultPreset ? `ctest --preset ${defaultPreset}` : 'ctest --test-dir build',
    proposed_lint: pathExists(path.join(projectRoot, '.clang-format')) ? 'clang-format --dry-run --Werror $(git ls-files "*.c" "*.cpp" "*.h" "*.hpp")' : '',
    confidence: 0.75,
    summary: 'Looks like a CMake project.'
  }
}

function summarizeBazel() {
  return {
    detected_stack: 'Bazel',
    proposed_build: 'bazel build //...',
    proposed_test: 'bazel test //...',
    proposed_lint: '',
    confidence: 0.8,
    summary: 'Looks like a Bazel workspace.'
  }
}

function summarizeMeson() {
  return {
    detected_stack: 'Meson',
    proposed_build: 'meson setup build && meson compile -C build',
    proposed_test: 'meson test -C build',
    proposed_lint: '',
    confidence: 0.75,
    summary: 'Looks like a Meson project.'
  }
}

function summarizeTerraform(projectRoot) {
  return {
    detected_stack: 'Terraform',
    proposed_build: 'terraform init && terraform validate',
    proposed_test: pathExists(path.join(projectRoot, '.terraform.lock.hcl')) ? 'terraform test' : '',
    proposed_lint: pathExists(path.join(projectRoot, '.tflint.hcl')) ? 'tflint' : 'terraform fmt -check -recursive',
    confidence: 0.8,
    summary: 'Looks like a Terraform project.'
  }
}

function summarizeNix() {
  return {
    detected_stack: 'Nix (flake)',
    proposed_build: 'nix build',
    proposed_test: 'nix flake check',
    proposed_lint: '',
    confidence: 0.75,
    summary: 'Looks like a Nix flake.'
  }
}

function summarizeDockerOnly(projectRoot) {
  const hasHadolint = pathExists(path.join(projectRoot, 'hadolint.yaml'))
    || pathExists(path.join(projectRoot, '.hadolint.yaml'))
  return {
    detected_stack: 'Docker',
    proposed_build: 'docker build .',
    proposed_test: '',
    proposed_lint: hasHadolint ? 'hadolint Dockerfile' : '',
    confidence: 0.6,
    summary: 'Looks like a Docker image repo.'
  }
}

function summarizeLooseNodeScripts(projectRoot) {
  const entries = walkShallow(projectRoot, { maxDepth: MANIFEST_WALK_DEPTH })
  const hasTestFiles = entries.some(e => /\.test\.m?js$/.test(e.name))
  const hasScripts = entries.some(e => /\.m?js$/.test(e.name))
  if (!hasScripts) return null
  if (!hasTestFiles) return null
  return {
    detected_stack: 'Node (scripts)',
    proposed_build: '',
    proposed_test: 'node --test tests/',
    proposed_lint: '',
    confidence: 0.4,
    summary: 'Loose Node scripts with built-in `node --test` style tests (no package.json).'
  }
}

function summarizeShellOnly(projectRoot) {
  const hasBats = pathExists(path.join(projectRoot, 'tests'))
    && walkShallow(path.join(projectRoot, 'tests'), { maxDepth: 1 }).some(entry => entry.name.endsWith('.bats'))
  const hasShellcheckrc = pathExists(path.join(projectRoot, '.shellcheckrc'))
  return {
    detected_stack: 'Shell',
    proposed_build: '',
    proposed_test: hasBats ? 'bats tests/' : '',
    proposed_lint: hasShellcheckrc ? 'shellcheck **/*.sh' : '',
    confidence: 0.55,
    summary: 'Looks like a shell-script project.'
  }
}

function applyMakeOverride(base, projectRoot) {
  const makefile = readTextIfExists(path.join(projectRoot, 'Makefile'))
    ?? readTextIfExists(path.join(projectRoot, 'GNUmakefile'))
  if (!makefile) return base
  const targets = new Set(parseMakefileTargets(makefile))
  const next = { ...base }
  if (!next.proposed_build && targets.has('build')) next.proposed_build = 'make build'
  if (!next.proposed_test && targets.has('test')) next.proposed_test = 'make test'
  if (!next.proposed_test && targets.has('check')) next.proposed_test = 'make check'
  if (!next.proposed_lint && targets.has('lint')) next.proposed_lint = 'make lint'
  return next
}

function applyJustOverride(base, projectRoot) {
  const text = readTextIfExists(path.join(projectRoot, 'justfile'))
    ?? readTextIfExists(path.join(projectRoot, 'Justfile'))
    ?? readTextIfExists(path.join(projectRoot, '.justfile'))
  if (!text) return base
  const recipes = new Set(parseJustfileRecipes(text))
  const next = { ...base }
  if (!next.proposed_build && recipes.has('build')) next.proposed_build = 'just build'
  if (!next.proposed_test && recipes.has('test')) next.proposed_test = 'just test'
  if (!next.proposed_lint && recipes.has('lint')) next.proposed_lint = 'just lint'
  return next
}

function applyTaskfileOverride(base, projectRoot) {
  const text = readTextIfExists(path.join(projectRoot, 'Taskfile.yml'))
    ?? readTextIfExists(path.join(projectRoot, 'Taskfile.yaml'))
    ?? readTextIfExists(path.join(projectRoot, 'taskfile.yml'))
  if (!text) return base
  const tasks = new Set(parseTaskfileTasks(text))
  const next = { ...base }
  if (!next.proposed_build && tasks.has('build')) next.proposed_build = 'task build'
  if (!next.proposed_test && tasks.has('test')) next.proposed_test = 'task test'
  if (!next.proposed_lint && tasks.has('lint')) next.proposed_lint = 'task lint'
  return next
}

function applyMakefileFallback(projectRoot) {
  const makefile = readTextIfExists(path.join(projectRoot, 'Makefile'))
    ?? readTextIfExists(path.join(projectRoot, 'GNUmakefile'))
  if (!makefile) return null
  const targets = new Set(parseMakefileTargets(makefile))
  return {
    detected_stack: 'Generic (Makefile)',
    proposed_build: targets.has('build') ? 'make build' : targets.has('all') ? 'make all' : '',
    proposed_test: targets.has('test') ? 'make test' : targets.has('check') ? 'make check' : '',
    proposed_lint: targets.has('lint') ? 'make lint' : '',
    confidence: 0.55,
    summary: 'I found a Makefile — starting from its usual targets.'
  }
}

function applyJustFallback(projectRoot) {
  const text = readTextIfExists(path.join(projectRoot, 'justfile'))
    ?? readTextIfExists(path.join(projectRoot, 'Justfile'))
    ?? readTextIfExists(path.join(projectRoot, '.justfile'))
  if (!text) return null
  const recipes = new Set(parseJustfileRecipes(text))
  return {
    detected_stack: 'Generic (just)',
    proposed_build: recipes.has('build') ? 'just build' : '',
    proposed_test: recipes.has('test') ? 'just test' : '',
    proposed_lint: recipes.has('lint') ? 'just lint' : '',
    confidence: 0.55,
    summary: 'I found a justfile — starting from its recipes.'
  }
}

function applyTaskfileFallback(projectRoot) {
  const text = readTextIfExists(path.join(projectRoot, 'Taskfile.yml'))
    ?? readTextIfExists(path.join(projectRoot, 'Taskfile.yaml'))
    ?? readTextIfExists(path.join(projectRoot, 'taskfile.yml'))
  if (!text) return null
  const tasks = new Set(parseTaskfileTasks(text))
  return {
    detected_stack: 'Generic (Taskfile)',
    proposed_build: tasks.has('build') ? 'task build' : '',
    proposed_test: tasks.has('test') ? 'task test' : '',
    proposed_lint: tasks.has('lint') ? 'task lint' : '',
    confidence: 0.55,
    summary: 'I found a Taskfile — starting from its tasks.'
  }
}

function applyToolConfigFallback(projectRoot) {
  const proposals = []
  if (pathExists(path.join(projectRoot, 'biome.json')) || pathExists(path.join(projectRoot, 'biome.jsonc'))) {
    proposals.push({ stack: 'JS/TS (Biome only)', lint: 'npx biome check .' })
  } else if (hasEslintConfig(projectRoot)) {
    proposals.push({ stack: 'JS/TS (ESLint only)', lint: 'npx eslint .' })
  }
  if (pathExists(path.join(projectRoot, 'ruff.toml')) || pathExists(path.join(projectRoot, '.ruff.toml'))) {
    proposals.push({ stack: 'Python (Ruff only)', lint: 'ruff check .' })
  }
  if (pathExists(path.join(projectRoot, 'tsconfig.json')) && proposals.length === 0) {
    proposals.push({ stack: 'TypeScript', lint: 'npx tsc --noEmit' })
  }
  if (proposals.length === 0) return null
  const first = proposals[0]
  return {
    detected_stack: first.stack,
    proposed_build: '',
    proposed_test: '',
    proposed_lint: first.lint,
    confidence: 0.45,
    summary: `Found ${first.stack} config only — proposing lint alone.`
  }
}

function detectRootEcosystem(projectRoot) {
  const has = (name) => pathExists(path.join(projectRoot, name))

  if (has('package.json')) {
    const denoJsonPresent = has('deno.json') || has('deno.jsonc')
    const packageJson = safeJsonParse(readTextIfExists(path.join(projectRoot, 'package.json'))) ?? {}
    const hasScripts = packageJson.scripts && Object.keys(packageJson.scripts).length > 0
    if (denoJsonPresent && !hasScripts) {
      return summarizeDeno(projectRoot)
    }
    return summarizeNode(projectRoot, readTextIfExists(path.join(projectRoot, 'package.json')))
  }
  if (has('deno.json') || has('deno.jsonc')) return summarizeDeno(projectRoot)

  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg') || has('requirements.txt') || has('Pipfile') || has('environment.yml') || has('environment.yaml')) {
    return summarizePython(projectRoot)
  }

  if (has('go.mod') || has('go.work')) return summarizeGo(projectRoot)
  if (has('Cargo.toml')) return summarizeRust(projectRoot)
  if (has('Gemfile') || has('Rakefile') || walkShallow(projectRoot, { maxDepth: 1 }).some(e => e.name.endsWith('.gemspec'))) {
    return summarizeRuby(projectRoot)
  }
  if (has('composer.json')) return summarizePhp(projectRoot)

  if (has('pom.xml')) return summarizeMaven(projectRoot)
  if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) {
    return summarizeGradle(projectRoot)
  }
  if (has('build.sbt')) {
    return {
      detected_stack: 'Scala (SBT)',
      proposed_build: 'sbt compile',
      proposed_test: 'sbt test',
      proposed_lint: has('.scalafmt.conf') ? 'sbt scalafmtCheckAll' : '',
      confidence: 0.8,
      summary: 'Looks like a Scala/SBT project.'
    }
  }

  if (has('global.json') || walkShallow(projectRoot, { maxDepth: 2 }).some(e => /\.(csproj|fsproj|vbproj|sln)$/.test(e.name))) {
    return summarizeDotnet()
  }

  if (has('Package.swift')) return summarizeSwiftPM()
  if (has('pubspec.yaml')) return summarizeDart(projectRoot)
  if (has('mix.exs')) return summarizeElixir(projectRoot)

  if (has('stack.yaml') || has('cabal.project') || has('package.yaml') || walkShallow(projectRoot, { maxDepth: 1 }).some(e => e.name.endsWith('.cabal'))) {
    return summarizeHaskell(projectRoot)
  }
  if (has('dune-project')) return summarizeOCaml()
  if (has('rebar.config')) return summarizeErlang()
  if (has('deps.edn') || has('project.clj')) return summarizeClojure(projectRoot)
  if (has('build.zig') || has('build.zig.zon')) return summarizeZig()
  if (walkShallow(projectRoot, { maxDepth: 1 }).some(e => e.name.endsWith('.nimble'))) return summarizeNim()
  if (has('shard.yml')) return summarizeCrystal()
  if (has('DESCRIPTION') || has('renv.lock')) return summarizeR()

  if (has('Project.toml')) {
    const julia = summarizeJulia(projectRoot)
    if (julia) return julia
  }

  if (has('CMakeLists.txt')) return summarizeCMake(projectRoot)
  if (has('WORKSPACE') || has('WORKSPACE.bazel') || has('MODULE.bazel')) return summarizeBazel()
  if (has('meson.build')) return summarizeMeson()

  if (walkShallow(projectRoot, { maxDepth: 1 }).some(e => e.name.endsWith('.tf'))) return summarizeTerraform(projectRoot)
  if (has('flake.nix') || has('default.nix')) return summarizeNix()

  const justFallback = applyJustFallback(projectRoot)
  if (justFallback) return justFallback
  const taskfileFallback = applyTaskfileFallback(projectRoot)
  if (taskfileFallback) return taskfileFallback
  const makeFallback = applyMakefileFallback(projectRoot)
  if (makeFallback) return makeFallback

  if (has('Dockerfile')) return summarizeDockerOnly(projectRoot)

  if (walkShallow(projectRoot, { maxDepth: 1 }).some(e => /\.(sh|bash|zsh)$/.test(e.name))) {
    return summarizeShellOnly(projectRoot)
  }

  const loose = summarizeLooseNodeScripts(projectRoot)
  if (loose) return loose

  const toolConfig = applyToolConfigFallback(projectRoot)
  if (toolConfig) return toolConfig

  return null
}

export function proposeProjectCommands(projectRoot) {
  const base = detectRootEcosystem(projectRoot)
  if (!base) {
    return {
      detected_stack: 'Unknown',
      proposed_build: '',
      proposed_test: '',
      proposed_lint: '',
      confidence: 0.2,
      summary: "I couldn't find a recognizable project manifest or tool config. That's fine — press \"ok\" for an empty config, or set commands with \"edit:\"."
    }
  }
  let result = applyJustOverride(base, projectRoot)
  result = applyTaskfileOverride(result, projectRoot)
  result = applyMakeOverride(result, projectRoot)
  return result
}

export function collectManifestSnippets(projectRoot) {
  const entries = walkShallow(projectRoot, { maxDepth: MANIFEST_WALK_DEPTH })
  const ranked = entries
    .filter(entry => isSignalFile(entry.name))
    .sort((a, b) => {
      const aPrimary = PRIMARY_MANIFEST_NAMES.has(a.name) ? 0 : LOCKFILE_NAMES.has(a.name) ? 1 : 2
      const bPrimary = PRIMARY_MANIFEST_NAMES.has(b.name) ? 0 : LOCKFILE_NAMES.has(b.name) ? 1 : 2
      if (aPrimary !== bPrimary) return aPrimary - bPrimary
      if (a.depth !== b.depth) return a.depth - b.depth
      return a.name.localeCompare(b.name)
    })
    .slice(0, MANIFEST_MAX_SNIPPETS)

  return ranked.map(entry => {
    const isLockfile = LOCKFILE_NAMES.has(entry.name)
    const snippet = isLockfile
      ? `(${entry.name} present — ${entry.depth === 0 ? 'root' : `depth ${entry.depth}`})`
      : firstLines(readTextIfExists(entry.absPath) ?? '')
    return {
      relative_path: relativeProjectPath(projectRoot, entry.absPath),
      snippet
    }
  })
}
