// @vitest-environment happy-dom
import { initializeForms } from '#client/form.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A `ResizeObserver` for a DOM with no layout: the test is the layout, giving each element a size with
 * `setContentSize`, which the observers of that element hear about as they would a real resize.
 */
class FakeLayout {
  private readonly sizes = new Map<Element, { width: number; height: number }>()
  private readonly observers = new Set<FakeResizeObserver>()

  readonly ResizeObserver = class implements FakeResizeObserver {
    readonly observed = new Set<Element>()

    constructor(
      private readonly callback: ResizeObserverCallback,
      private readonly layout: FakeLayout
    ) {
      layout.observers.add(this)
    }

    observe(target: Element) {
      this.observed.add(target)

      // A real observer reports each target once, as soon as it is observed.
      queueMicrotask(() => this.notify(target))
    }

    unobserve(target: Element) {
      this.observed.delete(target)
    }

    disconnect() {
      this.observed.clear()
      this.layout.observers.delete(this)
    }

    notify(target: Element) {
      if (!this.observed.has(target)) return

      const { width, height } = this.layout.sizes.get(target) ?? { width: 0, height: 0 }
      this.callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver
      )
    }
  }

  setContentSize(target: Element, width: number, height: number) {
    this.sizes.set(target, { width, height })
    for (const observer of this.observers) observer.notify(target)
  }
}

interface FakeResizeObserver {
  notify(target: Element): void
}

let layout: FakeLayout

beforeEach(() => {
  layout = new FakeLayout()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        return new layout.ResizeObserver(callback, layout)
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Mount an enhanced job application form, with a Turnstile container unless `widget` is false. */
function mountForm({ widget = true } = {}) {
  document.body.innerHTML = `
    <form data-astro-form action="/api/application" method="POST">
      <input type="text" name="name" />
      ${widget ? '<div class="cf-turnstile" data-appearance="interaction-only"></div>' : ''}
      <button type="submit">Send</button>
      <p data-astro-form-status></p>
    </form>`
  initializeForms()

  return document.querySelector<HTMLElement>('.cf-turnstile')
}

/** The container's state attribute once the observer has reported on it. */
async function settledState(container: HTMLElement) {
  await Promise.resolve()
  return container.getAttribute('data-astro-form-turnstile')
}

describe('Turnstile state', () => {
  it('puts no attribute on a form without a widget', async () => {
    const container = mountForm({ widget: false })

    expect(container).toBeNull()
    expect(document.querySelector('[data-astro-form-turnstile]')).toBeNull()
  })

  it('is invisible before a widget has rendered', async () => {
    const container = mountForm()!

    expect(container.getAttribute('data-astro-form-turnstile')).toBe('invisible')
    expect(await settledState(container)).toBe('invisible')
  })

  it('is invisible while an interaction-only widget shows nothing', async () => {
    const container = mountForm()!
    layout.setContentSize(container, 300, 0)

    expect(await settledState(container)).toBe('invisible')
  })

  it('is visible while a widget shows a challenge and invisible again after', async () => {
    const container = mountForm()!
    layout.setContentSize(container, 300, 65)
    expect(await settledState(container)).toBe('visible')

    layout.setContentSize(container, 300, 0)
    expect(await settledState(container)).toBe('invisible')
  })

  it('is visible for an always-shown widget', async () => {
    document.body.innerHTML = `
      <form data-astro-form action="/api/application" method="POST">
        <div class="cf-turnstile"></div>
        <p data-astro-form-status></p>
      </form>`
    const container = document.querySelector<HTMLElement>('.cf-turnstile')!
    layout.setContentSize(container, 300, 65)
    initializeForms()

    await vi.waitFor(() => expect(container.getAttribute('data-astro-form-turnstile')).toBe('visible'))
  })

  it('stops following the widget once the form has left the page', async () => {
    const container = mountForm()!
    const formElement = container.closest('form')!
    layout.setContentSize(container, 300, 65)
    expect(await settledState(container)).toBe('visible')

    formElement.remove()
    await new Promise((resolve) => setTimeout(resolve, 10))
    layout.setContentSize(container, 300, 0)

    expect(await settledState(container)).toBe('visible')
  })
})
