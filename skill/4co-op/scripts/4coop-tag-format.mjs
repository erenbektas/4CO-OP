export function stripLeadingTag(text) {
  return String(text ?? '')
    .replace(/^\[[^\]]+\]:\s*/u, '')
    .trim()
}

export function resolveStageTag(config, stage) {
  if (stage === 'meta') {
    return config.tags.meta
  }

  const template = config.tags[stage]
  const tagDisplay = config.models[stage]?.tag_display ?? stage
  return template.replace('{tag_display}', tagDisplay)
}

export function withTag(config, stage, text) {
  return `${resolveStageTag(config, stage)}: ${stripLeadingTag(text)}`
}

export function ensureTagged(config, stage, text) {
  const value = String(text ?? '')
  const tag = resolveStageTag(config, stage)
  if (value.startsWith(tag)) {
    return value
  }
  return `${tag}: ${stripLeadingTag(value)}`
}
