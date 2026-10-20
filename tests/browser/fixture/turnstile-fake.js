// A stand-in for Cloudflare's Turnstile loader (`api.js`), so browser tests are deterministic and never reach
// the network. Like the real loader, it renders every `.cf-turnstile` container on the page: a frame, and the
// hidden response input the form posts, which holds a token once one is issued. A widget whose container has
// `data-appearance="interaction-only"` shows nothing (its frame is zero-sized) until a challenge appears.
//
// Tests drive it through `window.__turnstileFake`:
//
// - `challenge()` shows a challenge in every widget: the frame grows, and the token is withheld.
// - `settle()` completes the challenge: an interaction-only frame shrinks back, and a token is issued.

;(() => {
  const RESPONSE_FIELD_NAME = 'cf-turnstile-response'
  const FRAME_WIDTH_PX = 300
  const FRAME_HEIGHT_PX = 65

  /** Each rendered container's widget: its frame, its response input, and whether a challenge is showing. */
  const widgets = new Map()
  let issuedTokenCount = 0

  /** Whether a container's widget shows nothing until it needs the person. */
  function isInteractionOnly(containerElement) {
    return containerElement.dataset.appearance === 'interaction-only'
  }

  /** Size a widget's frame to what it shows: a challenge, an always-shown widget, or nothing. */
  function sizeFrame(containerElement, widget) {
    const shown = widget.challenged || !isInteractionOnly(containerElement)
    widget.frameElement.style.width = shown ? `${FRAME_WIDTH_PX}px` : '0px'
    widget.frameElement.style.height = shown ? `${FRAME_HEIGHT_PX}px` : '0px'
  }

  /** Put a fresh token in a widget's response input, as the real widget does once it has verified the visitor. */
  function issueToken(widget) {
    issuedTokenCount += 1
    widget.inputElement.value = `fake-turnstile-token-${issuedTokenCount}`
  }

  /** Render one container's widget, once. */
  function render(containerElement) {
    if (widgets.has(containerElement)) return

    const frameElement = document.createElement('iframe')
    frameElement.title = 'Widget containing a Cloudflare security challenge'
    frameElement.style.border = '0'

    const inputElement = document.createElement('input')
    inputElement.type = 'hidden'
    inputElement.name = containerElement.dataset.responseFieldName || RESPONSE_FIELD_NAME

    const widget = { frameElement, inputElement, challenged: false }
    widgets.set(containerElement, widget)
    containerElement.append(frameElement, inputElement)
    sizeFrame(containerElement, widget)
    issueToken(widget)
  }

  /** Render every container on the page that has no widget yet. */
  function renderAll() {
    for (const containerElement of document.querySelectorAll('.cf-turnstile')) render(containerElement)
  }

  /** The containers an element or selector names, or every rendered one when given neither. */
  function containersFor(target) {
    if (target === undefined) return Array.from(widgets.keys())
    if (typeof target === 'string') return Array.from(document.querySelectorAll(target))

    return [target]
  }

  window.turnstile = {
    render(target) {
      for (const containerElement of containersFor(target)) render(containerElement)
    },

    /** Clear the spent token and issue a fresh one shortly after, as the real widget does, unless challenged. */
    reset(target) {
      for (const containerElement of containersFor(target)) {
        const widget = widgets.get(containerElement)
        if (!widget) continue

        widget.inputElement.value = ''
        setTimeout(() => {
          if (!widget.challenged) issueToken(widget)
        }, 50)
      }
    },

    getResponse(target) {
      const [containerElement] = containersFor(target)
      return containerElement ? widgets.get(containerElement)?.inputElement.value : undefined
    }
  }

  window.__turnstileFake = {
    challenge() {
      for (const [containerElement, widget] of widgets) {
        widget.challenged = true
        widget.inputElement.value = ''
        sizeFrame(containerElement, widget)
      }
    },

    settle() {
      for (const [containerElement, widget] of widgets) {
        widget.challenged = false
        sizeFrame(containerElement, widget)
        issueToken(widget)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll)
  } else {
    renderAll()
  }
})()
