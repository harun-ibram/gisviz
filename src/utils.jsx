export const toPublicUrl = (path) => {
  if (!path) return path
  // already absolute (http://... or starts with /) — leave as-is
  if (/^https?:\/\//i.test(path) || path.startsWith('/')) {
    return path
  }
  // relative project-root path like "splats/foo.splat" -> "/splats/foo.splat"
  return `/${path}`
}

