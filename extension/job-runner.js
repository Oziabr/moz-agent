const extractField = (selector, attribute) => {
  const elements = Array.from(document.querySelectorAll(selector))
  return elements.map(el => (attribute ? el.getAttribute(attribute) : el.textContent.trim()))
}

const runParseJob = payload => {
  const { selector, attribute } = payload
  if (!selector) throw new Error('parse job payload requires a selector')
  return extractField(selector, attribute)
}

const runCrawlJob = payload => {
  const { selector = 'a[href]', attribute = 'href' } = payload
  return extractField(selector, attribute)
}

// plain element.value = x doesn't trigger the reactivity most frameworks
// hook into (React etc track changes via the native setter, not the
// property directly) - going through the prototype's setter plus a real
// input/change event covers both plain HTML forms and framework-controlled
// ones.
const setNativeValue = (element, value) => {
  const prototype = Object.getPrototypeOf(element)
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

const runSubmitJob = payload => {
  const { formSelector, fields = {}, submitSelector } = payload
  if (!formSelector) throw new Error('submit job payload requires a formSelector')

  const form = document.querySelector(formSelector)
  if (!form) throw new Error(`no form matched ${formSelector}`)

  Object.entries(fields).forEach(([fieldSelector, value]) => {
    const field = form.querySelector(fieldSelector)
    if (!field) throw new Error(`no field matched ${fieldSelector}`)
    setNativeValue(field, value)
  })

  if (submitSelector) {
    const submitControl = form.querySelector(submitSelector)
    if (!submitControl) throw new Error(`no submit control matched ${submitSelector}`)
    submitControl.click()
  } else if (form.requestSubmit) {
    form.requestSubmit()
  } else {
    form.submit()
  }

  return { submitted: true }
}

const runJob = job => {
  if (job.type === 'parse') return runParseJob(job.payload)
  if (job.type === 'crawl') return runCrawlJob(job.payload)
  if (job.type === 'submit') return runSubmitJob(job.payload)
  throw new Error(`unknown job type ${job.type}`)
}

const handleMessage = (message, sender, sendResponse) => {
  if (message.type !== 'runJob') return false
  try {
    sendResponse({ ok: true, result: runJob(message.job) })
  } catch (err) {
    sendResponse({ ok: false, error: err.message })
  }
  return false
}

browser.runtime.onMessage.addListener(handleMessage)
