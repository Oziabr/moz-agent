const statusEl = document.getElementById('status')

const setStatus = text => { statusEl.textContent = text }

const onPopupLoad = () => setStatus('agent not connected')

document.addEventListener('DOMContentLoaded', onPopupLoad)
