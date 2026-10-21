// MARK: - Progress Parts

/** The state a progress part carries: the file field's vocabulary, set while bytes go up and once all are sent. */
export type UploadProgressState = 'uploading' | 'done'

const STATE_ATTRIBUTE = 'data-astro-form-file-state'

/**
 * Show `sent` of `total` bytes on a progress part: a native `<progress>` takes it as `value` and `max`, any other
 * element as `--astro-form-progress` (0 to 1), for the site's own bar to scale by. The part's state follows.
 */
export function showUploadProgress(
  partElement: HTMLElement,
  sent: number,
  total: number,
  state: UploadProgressState
): void {
  if (partElement instanceof HTMLProgressElement) {
    partElement.max = total
    partElement.value = sent
  } else {
    partElement.style.setProperty('--astro-form-progress', String(total > 0 ? sent / total : 0))
  }

  partElement.setAttribute(STATE_ATTRIBUTE, state)
}

/** Return a progress part to nothing sent, and take off the upload state it was showing. */
export function resetUploadProgress(partElement: HTMLElement): void {
  if (partElement instanceof HTMLProgressElement) {
    partElement.value = 0
  } else {
    partElement.style.setProperty('--astro-form-progress', '0')
  }

  clearUploadState(partElement)
}

/** Take off the upload state an element was showing, leaving any other state (`invalid`) as it is. */
export function clearUploadState(element: Element): void {
  const state = element.getAttribute(STATE_ATTRIBUTE)
  if (state === 'uploading' || state === 'done') element.removeAttribute(STATE_ATTRIBUTE)
}
