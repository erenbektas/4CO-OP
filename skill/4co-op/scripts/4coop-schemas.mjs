function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractFromCodeFence(text) {
  const match = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/i)
  return match ? match[1].trim() : null
}

function extractBalancedJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) {
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }

  return null
}

export function extractJsonObject(value) {
  if (isObject(value)) {
    return value
  }

  const text = String(value ?? '').trim()
  const candidates = [text, extractFromCodeFence(text), extractBalancedJson(text)].filter(Boolean)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }

  return null
}

function validateChecklist(items) {
  return Array.isArray(items) && items.every(item => isObject(item) && item.id && item.text && item.status)
}

function validateIssueList(items) {
  return Array.isArray(items) && items.every(item => isObject(item) && item.severity && item.file && Number.isInteger(item.line) && item.text)
}

function validateEvidenceList(items, allowedStatuses) {
  return Array.isArray(items) && items.every(item => {
    return isObject(item) &&
      item.id &&
      allowedStatuses.includes(item.status) &&
      item.evidence_file &&
      Number.isInteger(item.evidence_line) &&
      item.quote
  })
}

const validators = {
  planner(data) {
    return isObject(data) &&
      data.tagged_message &&
      typeof data.plan_markdown === 'string' &&
      validateChecklist(data.acceptance_checklist) &&
      Array.isArray(data.file_structure_hint) &&
      typeof data.definition_of_done === 'string'
  },
  builder(data) {
    return isObject(data) &&
      typeof data.session_id === 'string' &&
      Array.isArray(data.files_changed) &&
      Array.isArray(data.tests_added) &&
      typeof data.build === 'string' &&
      typeof data.tests === 'string' &&
      typeof data.lint === 'string' &&
      typeof data.commit_sha === 'string' &&
      typeof data.commit_message === 'string' &&
      typeof data.notes === 'string'
  },
  spec_checker(data) {
    return isObject(data) &&
      validateEvidenceList(data.results, ['PASS', 'FAIL', 'UNCLEAR']) &&
      typeof data.summary === 'string' &&
      typeof data.tagged_message === 'string'
  },
  escalation(data) {
    return isObject(data) &&
      validateEvidenceList(data.resolved, ['PASS', 'FAIL']) &&
      typeof data.tagged_message === 'string'
  },
  reviewer(data) {
    return isObject(data) &&
      validateIssueList(data.issues) &&
      typeof data.tagged_message === 'string' &&
      typeof data.body_markdown === 'string'
  },
  fixer(data) {
    return isObject(data) &&
      typeof data.session_id === 'string' &&
      Array.isArray(data.commits) &&
      Array.isArray(data.fixed_issues) &&
      Array.isArray(data.out_of_scope) &&
      typeof data.build === 'string' &&
      typeof data.tests === 'string' &&
      typeof data.lint === 'string'
  },
  gatekeeper(data) {
    return isObject(data) &&
      ['APPROVE', 'REJECT'].includes(data.verdict) &&
      ['CRITICAL', 'IMPORTANT', 'MINOR', 'NONE'].includes(data.severity) &&
      Array.isArray(data.issues)
  },
  narrator(data) {
    return isObject(data) && typeof data.tagged_message === 'string'
  },
  pr_writer(data) {
    return isObject(data) &&
      typeof data.title === 'string' && data.title.trim().length > 0 &&
      typeof data.body_markdown === 'string' && data.body_markdown.trim().length > 0 &&
      typeof data.tagged_message === 'string'
  }
}

export function validateStageResult(stage, data) {
  const validator = validators[stage]
  if (!validator) {
    throw new Error(`Unknown stage validator: ${stage}`)
  }
  return validator(data)
}

export function parseAndValidate(stage, text) {
  const parsed = extractJsonObject(text)
  if (!parsed) {
    throw new Error(`Unable to parse ${stage} output as JSON`)
  }
  if (!validateStageResult(stage, parsed)) {
    throw new Error(`${stage} output did not match the expected shape`)
  }
  return parsed
}
