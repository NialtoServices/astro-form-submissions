import { formatFileSize } from './file-size.js'

// MARK: - Types

/** One chosen file as its list item shows it. */
export interface ListedFile {
  file: File

  /** The message the item's problem slot shows, or `null` for a file without a problem. */
  problem: string | null
}

// MARK: - Slots

const NAME_SLOT = '[data-astro-form-file-name]'
const SIZE_SLOT = '[data-astro-form-file-size]'
const PROBLEM_SLOT = '[data-astro-form-file-problem]'
const REMOVE_SLOT = '[data-astro-form-file-remove]'

/** The item element itself when it is the slot, otherwise the first slot inside it. */
function findSlot(itemElement: Element, selector: string): HTMLElement | null {
  if (itemElement instanceof HTMLElement && itemElement.matches(selector)) return itemElement

  return itemElement.querySelector<HTMLElement>(selector)
}

// MARK: - File List

/**
 * A file field's `[data-astro-form-file-list-for]` list: one item per chosen file, each a copy of the element in
 * the list's `<template>`, with its name, size and problem slots filled. The markup and its styling are the
 * site's; the list only fills slots and sets `data-astro-form-file-state`.
 */
export class FileItemList {
  // MARK: - Properties

  readonly listElement: HTMLElement
  private readonly itemTemplateElement: Element
  private readonly itemElements: Element[] = []

  // MARK: - Object Lifecycle

  /**
   * @throws {Error} When the list has no `<template>`, or its template holds no element to copy for an item.
   */
  constructor(listElement: HTMLElement) {
    const templateElement = listElement.querySelector('template')
    if (!templateElement)
      throw new Error(`The file list for "${listElement.dataset.astroFormFileListFor}" has no <template>.`)

    const itemTemplateElement = templateElement.content.firstElementChild
    if (!itemTemplateElement) {
      throw new Error(`The file list for "${listElement.dataset.astroFormFileListFor}" has an empty <template>.`)
    }

    this.listElement = listElement
    this.itemTemplateElement = itemTemplateElement
  }

  // MARK: - Rendering

  /** Replace the listed items with one per file, in order. */
  render(listedFiles: readonly ListedFile[]): void {
    this.clear()
    for (const { file, problem } of listedFiles) {
      const itemElement = this.itemTemplateElement.cloneNode(true)
      if (!(itemElement instanceof Element)) continue

      this.fillItem(itemElement, file, problem)
      this.listElement.append(itemElement)
      this.itemElements.push(itemElement)
    }
  }

  /** Remove every listed item, leaving the site's template in place. */
  clear(): void {
    for (const itemElement of this.itemElements.splice(0)) itemElement.remove()
  }

  private fillItem(itemElement: Element, file: File, problem: string | null): void {
    const nameElement = findSlot(itemElement, NAME_SLOT)
    if (nameElement) {
      // Text, never markup, so a name such as `<img onerror=…>.pdf` shows as typed; `dir="auto"` keeps a
      // right-to-left name from reordering the text around it.
      nameElement.textContent = file.name
      if (!nameElement.hasAttribute('dir')) nameElement.dir = 'auto'
    }

    const sizeElement = findSlot(itemElement, SIZE_SLOT)
    if (sizeElement) sizeElement.textContent = formatFileSize(file.size)

    const problemElement = findSlot(itemElement, PROBLEM_SLOT)
    if (problemElement) {
      problemElement.textContent = problem ?? ''
      problemElement.hidden = problem === null
    }

    if (problem === null) {
      itemElement.removeAttribute('data-astro-form-file-state')
    } else {
      itemElement.setAttribute('data-astro-form-file-state', 'invalid')
    }
  }

  // MARK: - Lookup

  /** The remove control of the item at `index`, if the item and its control exist. */
  removeControl(index: number): HTMLElement | null {
    const itemElement = this.itemElements[index]
    return itemElement ? findSlot(itemElement, REMOVE_SLOT) : null
  }

  /** The index of the item whose remove control `targetElement` is or sits in, or `-1`. */
  indexOfRemoveControl(targetElement: Element): number {
    const removeElement = targetElement.closest(REMOVE_SLOT)
    if (!removeElement) return -1

    return this.itemElements.findIndex(
      (itemElement) => itemElement === removeElement || itemElement.contains(removeElement)
    )
  }
}
