const AGENT_SERVER_URL = 'ws://localhost:8765'

const logStartup = () => console.log('moz-agent: background loaded')

const connectToAgentServer = () => console.log('moz-agent: would connect to', AGENT_SERVER_URL)

const handleInstalled = details => console.log('moz-agent: installed', details.reason)

browser.runtime.onInstalled.addListener(handleInstalled)

logStartup()
connectToAgentServer()
