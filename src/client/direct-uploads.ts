import {
  isRecord,
  networkErrorCopy,
  postForm,
  resolveSubmitTimeout,
  type PostOutcome,
  type SubmissionContext
} from './submission.js'
import { applyTurnstileTokens, resetTurnstileWidget, waitForTurnstileToken } from './turnstile.js'

// MARK: - Configuration

/** How far an upload must advance, in percent, before the status region announces its progress again. */
const ANNOUNCED_PROGRESS_STEP_PERCENT = 25

const DEFAULT_DESCRIPTOR_FIELD = 'uploads'
const DEFAULT_RECEIPT_FIELD = 'upload'

// MARK: - Grants

/** Where and how to upload one file, and the receipt proving it was admitted, as the upload route grants them. */
interface GrantedUpload {
  url: string
  method: string
  headers: Record<string, string>
  receipt: string
}

/** Narrow the upload route's `uploads` list, or `null` when any entry is malformed. */
function readGrantedUploads(result: unknown): GrantedUpload[] | null {
  if (!isRecord(result) || !Array.isArray(result.uploads)) return null

  const uploads: GrantedUpload[] = []
  for (const entry of result.uploads) {
    if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.method !== 'string') return null
    if (typeof entry.receipt !== 'string' || !isRecord(entry.headers)) return null

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value === 'string') headers[name] = value
    }
    uploads.push({ url: entry.url, method: entry.method, headers, receipt: entry.receipt })
  }
  return uploads
}

// MARK: - Upload Inputs

/**
 * The file inputs whose files upload directly, rather than joining the submission. A disabled input is left
 * out, as a form leaves a disabled control out of its submission.
 */
export function uploadInputs(formElement: HTMLFormElement): HTMLInputElement[] {
  return Array.from(
    formElement.querySelectorAll<HTMLInputElement>('input[type="file"][data-astro-form-upload]:not(:disabled)')
  )
}

/** The form's data without any directly-uploaded file input. */
export function formDataWithoutUploads(formElement: HTMLFormElement, submitterElement: HTMLElement | null): FormData {
  const formData = submitterElement ? new FormData(formElement, submitterElement) : new FormData(formElement)
  for (const inputElement of uploadInputs(formElement)) {
    if (inputElement.name) formData.delete(inputElement.name)
  }
  return formData
}

// MARK: - Uploading

/**
 * Upload one file as instructed, reporting bytes sent as they go. Resolves `true` on a 2xx response and
 * `false` on any other status, a network failure, or `idleTimeoutMs` passing with no progress (a stalled
 * connection otherwise holds the form pending until the OS gives up). `XMLHttpRequest`, because `fetch`
 * reports no upload progress.
 */
function uploadFile(
  upload: GrantedUpload,
  file: File,
  idleTimeoutMs: number,
  onProgress: (loaded: number) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest()
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    // An idle deadline rather than a total one, so a large upload on a slow but moving link still finishes.
    const restartIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => request.abort(), idleTimeoutMs)
    }

    const finish = (stored: boolean) => {
      clearTimeout(idleTimer)
      resolve(stored)
    }

    request.open(upload.method, upload.url)
    for (const [name, value] of Object.entries(upload.headers)) request.setRequestHeader(name, value)

    request.upload.addEventListener('progress', (event) => {
      restartIdleTimer()
      if (event.lengthComputable) onProgress(event.loaded)
    })
    request.addEventListener('load', () => finish(request.status >= 200 && request.status < 300))
    request.addEventListener('error', () => finish(false))
    request.addEventListener('abort', () => finish(false))
    request.send(file)
    restartIdleTimer()
  })
}

/** Fill the uploading copy's `{current}`, `{total}` and `{percent}` placeholders. */
function formatUploadingMessage(template: string, current: number, total: number, percent: number): string {
  return template
    .replaceAll('{current}', String(current))
    .replaceAll('{total}', String(total))
    .replaceAll('{percent}', String(percent))
}

// MARK: - Submission

/**
 * The three-step submission for a form with direct uploads: ask the upload route where each file goes,
 * upload them with progress, then post the form with a receipt per file. Every step's failure ends the
 * attempt; a retry starts again from the first step with fresh grants. Files from a failed attempt are deleted
 * when the enricher refuses them, and otherwise left to the bucket's lifecycle rule.
 */
export async function submitWithUploads(
  context: SubmissionContext,
  uploadAction: string,
  submissionURL: string,
  formData: FormData,
  files: File[]
): Promise<PostOutcome & { formData?: FormData }> {
  const { formElement, statusElement, messages } = context

  const uploadRequest = new FormData()
  for (const [name, value] of formData) uploadRequest.append(name, value)
  uploadRequest.set(
    formElement.dataset.astroFormUploadField || DEFAULT_DESCRIPTOR_FIELD,
    JSON.stringify(files.map((file) => ({ name: file.name, size: file.size, type: file.type })))
  )

  const admission = await postForm(context, uploadAction, uploadRequest)
  if (!admission.ok) return admission

  // A dropped or quarantined request is granted nothing, and the form route meets the same verdict, so
  // the submission goes ahead without its files rather than revealing the difference.
  const granted = readGrantedUploads(admission.result)
  if (!granted || (granted.length > 0 && granted.length !== files.length)) {
    return { ok: false, error: messages.genericError ?? '' }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let bytesBefore = 0
  let announcedStep = -1
  for (const [index, upload] of granted.entries()) {
    const file = files[index]
    if (!file) break

    const onProgress = (loaded: number) => {
      const percent = totalBytes > 0 ? Math.min(100, Math.floor(((bytesBefore + loaded) * 100) / totalBytes)) : 100

      // The status element is a polite live region and progress arrives every few dozen milliseconds, so
      // it changes only as each file starts and at each step; the progress event carries every update.
      const step = Math.floor(percent / ANNOUNCED_PROGRESS_STEP_PERCENT)
      if (messages.uploading && (loaded === 0 || step !== announcedStep)) {
        statusElement.textContent = formatUploadingMessage(messages.uploading, index + 1, granted.length, percent)
        announcedStep = step
      }

      formElement.dispatchEvent(
        new CustomEvent('astro-form:upload-progress', {
          bubbles: true,
          detail: { current: index + 1, total: granted.length, loaded, size: file.size, percent }
        })
      )
    }

    onProgress(0)
    const stored = await uploadFile(upload, file, resolveSubmitTimeout(formElement), onProgress)
    if (!stored) return { ok: false, error: networkErrorCopy(messages) }

    bytesBefore += file.size
  }

  statusElement.textContent = messages.sending ?? ''

  // The upload route spent the Turnstile token, so the form route needs a fresh one.
  resetTurnstileWidget(formElement)
  await waitForTurnstileToken(formElement)

  const finalData = new FormData()
  for (const [name, value] of formData) finalData.append(name, value)
  applyTurnstileTokens(formElement, finalData)

  const receiptField = formElement.dataset.astroFormUploadReceiptField || DEFAULT_RECEIPT_FIELD
  for (const upload of granted) finalData.append(receiptField, upload.receipt)

  const outcome = await postForm(context, submissionURL, finalData)
  return outcome.ok ? { ...outcome, formData: finalData } : outcome
}
