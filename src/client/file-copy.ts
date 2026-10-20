/**
 * The default English copy for file fields, shared by the server's refusals and the browser's own checks so
 * the same limit reads the same wherever it is caught. `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and
 * `{types}` are filled from the field's limits; see `fillPlaceholders`.
 */
export const FILE_COPY = {
  /** Over `maxFiles`, when more than one file is allowed. */
  tooManyFiles: 'Please attach no more than {maxFiles} files.',

  /** Over `maxFiles`, when only one file is allowed. */
  tooManyFilesSingle: 'Please attach only one file.',

  /** One file over `maxFileBytes`. */
  fileTooLarge: 'Each file must be {maxFileSize} or smaller.',

  /** The files together over `maxTotalBytes`. */
  filesTooLarge: 'Your files add up to more than {maxTotalSize}.',

  /** A file whose type is not accepted. */
  fileType: 'That file type is not accepted. Please attach {types}.',

  /** A required file field left empty. */
  fileRequired: 'Please attach a file.',

  /** A second file added to a field that takes one. */
  onlyOneFile: 'Only one file can be added.'
} as const
