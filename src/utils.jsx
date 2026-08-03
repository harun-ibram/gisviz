export const getFileName = (path) => path?.split('/').pop() ?? ''

export const getFileExtension = (fileName) => fileName?.split('.').pop()?.toLowerCase() ?? ''
