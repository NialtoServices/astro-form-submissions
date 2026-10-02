import { admit, ERRORS, type AdmissionConfig } from '#admission.js'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  FileUploads
} from '#enrichers/file-uploads.js'
import { ALL_TYPES, type FileMatcher } from '#files/sniff.js'
import { containedReporter, type ErrorReporter, type FormErrorStage } from '#reporting.js'
import { jsonFormError, jsonOk } from '#responses.js'
import { type SchemaInput } from '#schema.js'
import { assertValidSigningSecret } from '#tokens.js'
import { signUploadClaims } from '#uploads/upload-claims.js'
import { type PendingUpload, type UploadInstruction, type UploadTarget } from '#uploads/upload-target.js'
import { type APIRoute } from 'astro'

/** Default receipt lifetime — one hour, enough to finish every upload and submit. */
const DEFAULT_RECEIPT_TTL_SECONDS = 60 * 60

/** The content-type an upload is stored with when its declared type isn't one the form accepts. */
const OPAQUE_CONTENT_TYPE = 'application/octet-stream'

/** Configuration for {@link createUploadRoute}. */
export interface UploadRouteConfig<S extends SchemaInput> extends AdmissionConfig<S> {
  /** Where admitted files are uploaded to. */
  target: UploadTarget

  /** The HMAC secret receipts are signed with; the {@link UploadedFiles} enricher needs the same one. */
  secret: string

  /** Receipt lifetime in seconds. Default one hour. */
  receiptTtlSeconds?: number

  /** Form field carrying the JSON file descriptors. Default `uploads`. */
  field?: string

  /** Maximum number of files per submission. Default {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number

  /** Maximum size of a single file, in bytes. Default {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number

  /** Maximum combined size of all files, in bytes. Default {@link DEFAULT_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number

  /**
   * The types the form accepts: a declared type among these matchers' content-types is stored as
   * declared, anything else as `application/octet-stream`. Pass the same list as the
   * {@link UploadedFiles} enricher, which sniffs the stored bytes against it. Default {@link ALL_TYPES}.
   */
  accept?: FileMatcher[]

  /** Called when an error would otherwise be swallowed. The same contract as the form route's `onError`. */
  onError?: ErrorReporter
}

/** One file as the browser describes it: untrusted, and only ever used to bound what is granted. */
interface FileDescriptor {
  name: string
  size: number
  type: string
}

/** One granted upload: where to send the file, and the receipt that proves it was admitted. */
export interface GrantedUpload extends UploadInstruction {
  /** The signed receipt the final submission carries in place of the file. */
  receipt: string
}

/**
 * Reads the descriptor field as a JSON array of `{ name, size, type }`, or `null` when it is malformed.
 * A missing field is an empty list.
 */
function readDescriptors(value: FormDataEntryValue | null): FileDescriptor[] | null {
  if (value === null) return []
  if (typeof value !== 'string') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null

  const descriptors: FileDescriptor[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null

    const { name, size, type } = entry as Record<string, unknown>
    if (typeof name !== 'string' || typeof type !== 'string') return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

    descriptors.push({ name, size, type })
  }

  return descriptors
}

/**
 * Builds the `POST` handler for an upload route: the first step of a submission whose files upload
 * straight to storage. It admits the request exactly as the form route does (guards → schema →
 * inspectors), checks the declared files against the limits, and answers `{ ok: true, uploads }` with,
 * per file and in order, where to upload it and a signed receipt for the final submission.
 *
 * The request is the form's own fields (without the files) plus a JSON array of `{ name, size, type }`
 * under `field`. A dropped or quarantined request answers `{ ok: true, uploads: [] }`: the sender sees no
 * difference and no storage is granted.
 *
 * Object keys are generated here, never chosen by the client, and declared sizes and types only bound
 * what is granted: the {@link UploadedFiles} enricher checks the stored objects themselves.
 */
export function createUploadRoute<const S extends SchemaInput>(config: UploadRouteConfig<S>): APIRoute {
  assertValidSigningSecret(config.secret)

  const report = containedReporter(config.onError)
  const field = config.field ?? 'uploads'
  const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxTotalBytes = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const receiptTtlSeconds = config.receiptTtlSeconds ?? DEFAULT_RECEIPT_TTL_SECONDS
  const acceptedTypes = new Set((config.accept ?? ALL_TYPES).map((matcher) => matcher.contentType))

  return async (context) => {
    const { request, site, url } = context
    const submittedAt = new Date()

    const pendingReports: Promise<void>[] = []
    const registerReport = (error: unknown, stage: FormErrorStage): void => {
      pendingReports.push(report(error, stage))
    }

    const clientAddress = (): string | undefined => {
      try {
        return context.clientAddress
      } catch {
        return undefined
      }
    }

    try {
      const admission = await admit(config, { request, url, site, submittedAt, clientAddress, report, registerReport })
      if (admission.outcome === 'respond') return admission.response
      if (admission.outcome === 'drop' || admission.quarantined) return jsonOk({ uploads: [] })

      const { formData } = admission
      const fail = (error: Parameters<typeof jsonFormError>[0]) =>
        jsonFormError(error, config.errors, { data: formData })

      const descriptors = readDescriptors(formData.get(field))
      if (!descriptors) return fail(ERRORS.invalidForm)
      if (descriptors.length > maxFiles) return fail(FileUploads.errors.tooManyFiles)

      let totalBytes = 0
      for (const descriptor of descriptors) {
        if (descriptor.size > maxFileBytes) return fail(FileUploads.errors.fileTooLarge)

        totalBytes += descriptor.size
        if (totalBytes > maxTotalBytes) return fail(FileUploads.errors.fileTooLarge)
      }

      const uploads: GrantedUpload[] = []
      for (const descriptor of descriptors) {
        const upload: PendingUpload = {
          objectKey: crypto.randomUUID(),
          filename: descriptor.name.replace(/[\r\n"]/g, '') || 'upload',
          size: descriptor.size,
          contentType: acceptedTypes.has(descriptor.type) ? descriptor.type : OPAQUE_CONTENT_TYPE
        }

        const instruction = await config.target.prepare(upload)
        const receipt = await signUploadClaims('receipt', upload, receiptTtlSeconds, config.secret)
        uploads.push({ ...instruction, receipt })
      }

      return jsonOk({ uploads })
    } catch (error) {
      await report(error, 'unexpected')
      return jsonFormError(ERRORS.unavailable, config.errors)
    } finally {
      await Promise.allSettled(pendingReports)
    }
  }
}
