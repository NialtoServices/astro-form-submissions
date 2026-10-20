import { clearFieldError, replaceFieldErrorMessage } from './field-errors.js'
import { checkFiles, describeAcceptedTypes, readFileLimits, type FileLimits, type FileProblem } from './file-checks.js'
import { FILE_COPY } from './file-copy.js'
import { FileItemList } from './file-list.js'
import { formatFileSize } from './file-size.js'
import type { FormPartHost, FormTeardown, SubmitRefusal } from './form-controller.js'
import { message } from './messages.js'

// MARK: - Configuration

/** The parts of a file field the script finds by the field's name, each marked invalid with the field. */
const FIELD_PART_ATTRIBUTES = ['data-astro-form-file-list-for'] as const

/** Each problem's message attribute name and default copy, the same wording the server's refusals use. */
const PROBLEM_MESSAGES: Record<FileProblem, { name: string; fallback: (limits: FileLimits) => string }> = {
  tooManyFiles: {
    name: 'too-many-files',
    fallback: (limits) => (limits.maxFiles === 1 ? FILE_COPY.tooManyFilesSingle : FILE_COPY.tooManyFiles)
  },
  fileTooLarge: { name: 'file-too-large', fallback: () => FILE_COPY.fileTooLarge },
  filesTooLarge: { name: 'files-too-large', fallback: () => FILE_COPY.filesTooLarge },
  fileType: { name: 'file-type', fallback: () => FILE_COPY.fileType }
}

/** Two picks of one file share its name, size and modification time; a different file of the same name doesn't. */
function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

// MARK: - File Field

/**
 * Manages one file input that has a `[data-astro-form-file-list-for]` list: picks accumulate (a single-file
 * input's pick replaces), an identical file is listed once, each file can be removed, each is checked against
 * the input's limits, and the form won't send while any file has a problem. The input always holds exactly the
 * listed files, so the form, and a direct upload, sends what the person sees.
 */
export class FileFieldController {
  // MARK: - Properties

  private readonly inputElement: HTMLInputElement
  private readonly formElement: HTMLFormElement
  private readonly fileList: FileItemList
  private readonly files: File[] = []
  private readonly invalidObserver: MutationObserver
  private readonly disabledObserver: MutationObserver

  // MARK: - Object Lifecycle

  /**
   * Bind the input to its list, list any files it already holds, and add the field's check to the form's.
   *
   * @throws {Error} When the input has no name, or the list has no usable `<template>`.
   */
  constructor(inputElement: HTMLInputElement, listElement: HTMLElement, host: FormPartHost) {
    if (!inputElement.name) throw new Error('A file input with a file list has no name.')

    this.inputElement = inputElement
    this.formElement = host.formElement
    this.fileList = new FileItemList(listElement)

    const { signal } = host
    inputElement.addEventListener('change', () => this.addChosenFiles(), { signal })
    listElement.addEventListener('click', (event) => this.handleListClick(event), { signal })
    host.formElement.addEventListener('reset', (event) => this.handleReset(event), { signal })
    host.addSubmitCheck(() => this.refusal())

    // The server's refusals mark the input `aria-invalid` as well as the field's own checks, so the mirror
    // follows the attribute itself.
    this.invalidObserver = new MutationObserver(() => this.mirrorInvalidState())
    this.invalidObserver.observe(inputElement, { attributes: true, attributeFilter: ['aria-invalid'] })

    // The input can be disabled directly or through any `<fieldset>` around it.
    this.disabledObserver = new MutationObserver(() => {
      if (this.files.length > 0 && inputElement.matches(':disabled')) this.replaceFiles([])
    })
    this.disabledObserver.observe(host.formElement, { attributes: true, attributeFilter: ['disabled'], subtree: true })

    this.files.push(...Array.from(inputElement.files ?? []))
    this.render()
    this.mirrorInvalidState()
  }

  /** Stop following the field and remove its listed items, leaving the input holding its files. */
  disconnect(): void {
    this.invalidObserver.disconnect()
    this.disabledObserver.disconnect()
    this.fileList.clear()
  }

  // MARK: - Derived State

  private get name(): string {
    return this.inputElement.name
  }

  private get limits(): FileLimits {
    return readFileLimits(this.inputElement)
  }

  /**
   * The values the field's messages may use: `{maxFiles}`, `{maxFileSize}`, `{maxTotalSize}` and `{types}`, which
   * is the server's wording from `data-astro-form-accepted-types` when the input has it.
   */
  private get placeholders(): Record<string, string> {
    const { maxFiles, maxFileBytes, maxTotalBytes, accept } = this.limits
    return {
      maxFiles: String(maxFiles),
      maxFileSize: formatFileSize(maxFileBytes),
      maxTotalSize: formatFileSize(maxTotalBytes),
      types: this.inputElement.getAttribute('data-astro-form-accepted-types')?.trim() || describeAcceptedTypes(accept)
    }
  }

  /** The message for a problem: the input's own copy for it, or the default. */
  private problemMessage(problem: FileProblem): string {
    const { name, fallback } = PROBLEM_MESSAGES[problem]
    return message(this.inputElement, name, fallback(this.limits), this.placeholders)
  }

  // MARK: - Selection

  /** Take a pick from the picker: added to the files already listed, or in place of them for a single file. */
  private addChosenFiles(): void {
    const chosenFiles = Array.from(this.inputElement.files ?? [])

    // A picker closed without a choice may leave the input empty, which removes nothing.
    if (chosenFiles.length === 0) {
      this.replaceFiles(this.files)
      return
    }

    if (!this.inputElement.multiple) {
      this.replaceFiles(chosenFiles.slice(0, 1))
      return
    }

    const listedKeys = new Set(this.files.map(fileKey))
    const addedFiles = chosenFiles.filter((file) => {
      const key = fileKey(file)
      if (listedKeys.has(key)) return false

      listedKeys.add(key)
      return true
    })
    this.replaceFiles([...this.files, ...addedFiles])
  }

  /**
   * Remove the file at `index`, moving focus to the next file's remove control, or the input once none is left.
   * The field's error stays while another file still has a problem, now naming that file's, and clears once none
   * does.
   */
  private removeFile(index: number): void {
    this.replaceFiles(this.files.filter((_file, fileIndex) => fileIndex !== index))

    const remainingProblem = checkFiles(this.files, this.limits).find((problem) => problem !== null)
    if (remainingProblem) {
      replaceFieldErrorMessage(this.formElement, this.name, this.problemMessage(remainingProblem))
    } else {
      clearFieldError(this.formElement, this.name)
    }

    const nextIndex = Math.min(index, this.files.length - 1)
    ;(this.fileList.removeControl(nextIndex) ?? this.inputElement).focus()
  }

  /** Make `files` the field's selection: what the list shows and the input holds. */
  private replaceFiles(files: readonly File[]): void {
    const dataTransfer = new DataTransfer()
    for (const file of files) dataTransfer.items.add(file)
    this.inputElement.files = dataTransfer.files
    this.files.splice(0, this.files.length, ...files)
    this.render()
  }

  // MARK: - Events

  private handleListClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return

    const index = this.fileList.indexOfRemoveControl(event.target)
    if (index === -1) return

    // A remove `<button>` without `type="button"` would otherwise submit the form.
    event.preventDefault()
    this.removeFile(index)
  }

  /** Clear the selection with the form's other fields, unless a listener cancelled the reset. */
  private handleReset(event: Event): void {
    if (event.defaultPrevented) return

    this.replaceFiles([])
  }

  // MARK: - Checks

  /**
   * The field's refusal of a send: an empty required field, or the first file with a problem. A disabled
   * field is never checked, as the browser never sends it.
   */
  private refusal(): SubmitRefusal | null {
    const { inputElement, name } = this
    if (inputElement.matches(':disabled')) return null

    if (this.files.length === 0) {
      if (!inputElement.required) return null

      return {
        name,
        message: message(inputElement, 'file-required', FILE_COPY.fileRequired),
        focusElement: inputElement
      }
    }

    const problems = checkFiles(this.files, this.limits)
    const index = problems.findIndex((problem) => problem !== null)
    const problem = problems[index]
    if (!problem) return null

    return {
      name,
      message: this.problemMessage(problem),
      focusElement: this.fileList.removeControl(index) ?? inputElement
    }
  }

  // MARK: - Presentation

  private render(): void {
    const problems = checkFiles(this.files, this.limits)
    this.fileList.render(
      this.files.map((file, index) => {
        const problem = problems[index]
        return { file, problem: problem ? this.problemMessage(problem) : null }
      })
    )
  }

  /** Mark the field's parts `data-astro-form-invalid` while the input is `aria-invalid`, for styling a wrapper. */
  private mirrorInvalidState(): void {
    const invalid = this.inputElement.getAttribute('aria-invalid') === 'true'
    for (const attribute of FIELD_PART_ATTRIBUTES) {
      const partElements = this.formElement.querySelectorAll(`[${attribute}="${CSS.escape(this.name)}"]`)
      for (const partElement of partElements) {
        if (invalid) {
          partElement.setAttribute('data-astro-form-invalid', 'true')
        } else {
          partElement.removeAttribute('data-astro-form-invalid')
        }
      }
    }
  }
}

// MARK: - Initialisation

/**
 * Bind a {@link FileFieldController} to each file input in a form that has a file list, so a field without the
 * list markup stays as the browser provides it. A field whose markup is broken is reported and left alone, and
 * the form's other fields carry on.
 */
export function attachFileFields(formElement: HTMLFormElement, host: FormPartHost): FormTeardown | void {
  const controllers: FileFieldController[] = []
  for (const inputElement of formElement.querySelectorAll<HTMLInputElement>('input[type="file"][name]')) {
    const listElement = formElement.querySelector<HTMLElement>(
      `[data-astro-form-file-list-for="${CSS.escape(inputElement.name)}"]`
    )
    if (!listElement) continue

    try {
      controllers.push(new FileFieldController(inputElement, listElement, host))
    } catch (error) {
      console.error('[astro-form-submissions] Failed to initialize FileFieldController', error)
    }
  }

  if (controllers.length === 0) return

  return () => {
    for (const controller of controllers) controller.disconnect()
  }
}
