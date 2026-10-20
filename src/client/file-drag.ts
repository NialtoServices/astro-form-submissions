// MARK: - State

/** Every element a file drag may be dropped on, across the page's forms. */
const dropTargetElements = new Set<Element>()

/** Aborts the document's drag listeners; set while any drop target is registered. */
let documentListenerAbortController: AbortController | undefined

// MARK: - Drags

/** Whether a drag carries files, as opposed to text, a link or an element being dragged about the page. */
export function dragCarriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

// MARK: - Drag Safety

/**
 * Register an element as somewhere a file may be dropped. While any element is registered, the document stops
 * the browser opening a dropped file that misses every one of them, and the listeners are released with the
 * last element. An enabled file input nobody registered keeps the browser's own handling of a drop on it.
 *
 * @returns Unregisters the element.
 */
export function registerDropTarget(element: Element): () => void {
  dropTargetElements.add(element)

  if (!documentListenerAbortController) {
    documentListenerAbortController = new AbortController()
    const { signal } = documentListenerAbortController
    document.addEventListener('dragover', guardStrayFileDrag, { signal })
    document.addEventListener('drop', guardStrayFileDrag, { signal })
  }

  return () => {
    dropTargetElements.delete(element)
    if (dropTargetElements.size > 0) return

    documentListenerAbortController?.abort()
    documentListenerAbortController = undefined
  }
}

/**
 * Cancel a file drag that is over no drop target. Without the cancel the browser's default for a dropped file is
 * to navigate to it, replacing the page and discarding what the person has typed. Cancelling the drag over the
 * page also shows the person that a drop there does nothing.
 */
function guardStrayFileDrag(event: DragEvent): void {
  if (!dragCarriesFiles(event)) return

  const { target } = event
  if (!(target instanceof Node)) return

  // A disabled file input takes no drop, so a file dropped on it would be opened like one dropped on the page.
  if (target instanceof HTMLInputElement && target.type === 'file' && !target.matches(':disabled')) return

  for (const dropTargetElement of dropTargetElements) {
    if (dropTargetElement.contains(target)) return
  }

  event.preventDefault()
  if (event.type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}
